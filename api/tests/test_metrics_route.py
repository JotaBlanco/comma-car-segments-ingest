"""The Prometheus scrape route (FR-DM-081).

The platform build already runs Prometheus and Grafana. The gap the row names
is that this API emits no series at all, so a dashboard can graph nothing of
ours. These tests hold the four things that matter:

1. The route answers, it answers without a token, and it names its series.
2. The route leaks no identifier. A label carries a route TEMPLATE, never a
   request path, so no file id and no free path reaches the scrape.
3. A label value comes from a small fixed set, so no caller can mint an
   unbounded number of series.
4. The storage series reports the registry byte total, it states its own limit,
   and a broken Mongo never makes the route fail.
"""

import pytest

from api import metrics

# A value a test sends and then hunts for in the scrape body.
LEAKY_FILE_ID = "leaky-file-id-9f3c1"
LEAKY_PATH_WORD = "leaky-unmatched-path-9f3c1"
LEAKY_STORAGE_WORD = "leaky-storage-marker-7ab21"


class _FakeFiles:
    """A stand-in for the `files` collection. It needs no Docker and no Mongo.

    `rows` is what `aggregate` answers. `error` makes it raise instead, so a
    test drives the broken-registry path without breaking a real database.
    """

    def __init__(self, rows: list[dict] | None = None, error: Exception | None = None) -> None:
        self.rows = rows or []
        self.error = error
        self.pipelines: list[list[dict]] = []

    def aggregate(self, pipeline):
        self.pipelines.append(pipeline)
        if self.error is not None:
            raise self.error
        return iter(self.rows)


class _FakeDatabase:
    """A database handle that serves one collection."""

    def __init__(self, files: _FakeFiles) -> None:
        self.files = files

    def __getitem__(self, name: str) -> _FakeFiles:
        assert name == "files"
        return self.files


@pytest.fixture
def scrape(bare_client):
    """Read the scrape body as text. No token, on purpose."""

    def read() -> str:
        response = bare_client.get("/metrics")
        assert response.status_code == 200
        return response.text

    return read


# --- 1. the route answers and names its series -------------------------------


def test_metrics_answers_without_a_token(bare_client):
    """A Prometheus scrape carries no bearer token, so this route must be open."""
    response = bare_client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]


@pytest.mark.parametrize(
    "series",
    [
        "tm_api_http_requests_total",
        "tm_api_http_request_duration_seconds",
        "tm_api_uptime_seconds",
        "tm_api_storage_registry_bytes",
    ],
)
def test_the_scrape_names_every_series(scrape, series):
    """A renamed series breaks every dashboard, so the names are pinned here."""
    assert f"# TYPE {series}" in scrape()


def test_the_scrape_reports_uptime_latency_and_errors(bare_client, scrape):
    """The row asks for uptime, latency and errors. One request proves all three."""
    bare_client.get("/health")
    body = scrape()

    assert 'tm_api_http_requests_total{method="GET",route="/health",status="200"}' in body
    assert 'tm_api_http_request_duration_seconds_bucket{le="+Inf"' in body
    assert "tm_api_uptime_seconds " in body


def test_a_refused_request_counts_as_an_error(bare_client, scrape):
    """An error rate is a ratio over the status label, so a 401 must appear."""
    bare_client.get("/api/v1/test-runs")
    body = scrape()

    assert 'route="/api/v1/test-runs",status="401"' in body


# --- 2. the route leaks nothing ----------------------------------------------


def test_the_scrape_reports_the_route_template_and_never_the_file_id(bare_client, scrape):
    """A download of one file must never put that file id in a series.

    The request answers 401, and the label still reads the template: the router
    matches the route before the token check runs.
    """
    bare_client.get(f"/api/v1/files/{LEAKY_FILE_ID}")
    body = scrape()

    assert 'route="/api/v1/files/{file_id}"' in body
    assert LEAKY_FILE_ID not in body


def test_an_unmatched_request_never_puts_its_path_in_a_series(bare_client, scrape):
    """Any caller can invent a path. A raw path label would let one caller mint
    one series per request, and it would copy the caller's string into the scrape."""
    bare_client.get(f"/{LEAKY_PATH_WORD}")
    body = scrape()

    assert f'route="{metrics.UNMATCHED_ROUTE}"' in body
    assert LEAKY_PATH_WORD not in body


def test_the_scrape_carries_no_token_and_no_workspace_value(bare_client, scrape, monkeypatch):
    """The process holds a token and a workspace id. Neither may reach a series."""
    monkeypatch.setenv("Quix__Workspace__Id", "ws-secret-9f3c1")
    bare_client.get("/health")
    body = scrape()

    assert "ws-secret-9f3c1" not in body
    assert "test-token-not-a-secret" not in body
    assert "Authorization" not in body


# --- 3. every label value comes from a small fixed set -----------------------


def test_a_free_method_token_reads_as_other():
    """An ASGI server accepts any token as a method. Only the known set labels."""
    assert metrics.method_label("GET") == "GET"
    assert metrics.method_label("BREW-9f3c1") == metrics.OTHER_METHOD


def test_a_scope_with_no_route_reads_as_unmatched():
    """A scope with no matched route must never fall back to the raw path."""
    assert metrics.route_label({"path": "/anything"}) == metrics.UNMATCHED_ROUTE


def test_every_bound_route_template_holds_no_value(app):
    """A template is a fixed string. A bound value would be an unbounded label."""
    metrics.bind_routes(app)
    templates = set(metrics._ROUTE_TEMPLATES.values())

    assert "/health" in templates
    assert "/api/v1/files/{file_id}" in templates
    assert all(template.startswith("/") for template in templates)


def test_the_metrics_route_is_absent_from_the_contract(app):
    """The OpenAPI document describes the v1 JSON contract a client calls.

    This route serves the Prometheus text format. It stays out, and the
    committed snapshot therefore stays unchanged.
    """
    assert "/metrics" not in app.openapi()["paths"]


# --- 4. the storage utilisation series ---------------------------------------
#
# FR-DM-081 names storage utilisation beside uptime, latency and errors. The
# API cannot read the SAG bucket total, so the series reports the registry sum
# instead, and the HELP text states that limit. These tests hold three lines:
# the number is the planted one, a broken registry never breaks the scrape, and
# no stored value reaches the body.


def test_the_storage_series_reports_the_planted_registry_total(scrape):
    """The series must report the byte sum the registry holds, and nothing else."""
    database = _FakeDatabase(_FakeFiles([{"_id": None, "bytes": 1536}]))

    metrics.refresh_storage_bytes(database)

    assert "tm_api_storage_registry_bytes 1536.0" in scrape()


def test_an_empty_registry_reports_zero_bytes(scrape):
    """An empty collection answers no row. Zero is the true total, not "unknown"."""
    metrics.refresh_storage_bytes(_FakeDatabase(_FakeFiles([])))

    assert "tm_api_storage_registry_bytes 0.0" in scrape()


def test_the_help_text_states_that_this_is_not_real_bucket_usage(scrape):
    """A reader of the scrape must read the limit beside the number."""
    body = scrape()

    assert "NOT real bucket usage" in body


def test_a_broken_registry_never_breaks_the_scrape(bare_client):
    """Mongo can be slow, absent or broken. `/metrics` must still answer 200.

    The collector swallows the fault, so the series keeps the last value it
    knew. A scrape that answered 500 would blind the dashboard on uptime,
    latency and errors as well.
    """
    from pymongo.errors import ServerSelectionTimeoutError

    database = _FakeDatabase(_FakeFiles(error=ServerSelectionTimeoutError("mongo is away")))

    metrics.refresh_storage_bytes(database)

    assert bare_client.get("/metrics").status_code == 200


def test_the_storage_series_leaks_no_stored_value(scrape):
    """The collector reads a byte total. No stored string may reach the scrape.

    The fake row carries a marker in the two fields a file document really
    holds. A collector that copied any of them into a label would put a
    filename, a storage reference or a workspace value in the body.
    """
    row = {
        "_id": LEAKY_STORAGE_WORD,
        "bytes": 4096,
        "filename": LEAKY_STORAGE_WORD,
        "storage_ref": f"blob://{LEAKY_STORAGE_WORD}/measurement.mf4",
    }

    metrics.refresh_storage_bytes(_FakeDatabase(_FakeFiles([row])))

    assert LEAKY_STORAGE_WORD not in scrape()


def test_the_registry_read_groups_every_file_into_one_row():
    """The pipeline must return one number, so no row can ever carry a value."""
    files = _FakeFiles([{"_id": None, "bytes": 1}])

    metrics.refresh_storage_bytes(_FakeDatabase(files))

    assert files.pipelines == [[{"$group": {"_id": None, "bytes": {"$sum": "$size_bytes"}}}]]
