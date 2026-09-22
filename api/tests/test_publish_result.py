"""The QuixLab publish helper: how it finds the Test Manager, and what it posts.

The module under test is `notebooks/publish_result.py`. It is one paste-able
notebook cell, so it imports nothing from `api/`. These tests import it as a
plain module and replace one seam, `_http`.

Two groups live here.

**The discovery group** proves the match rule. The rule decides where a
viewer's token goes, so the tests state the negative cases first: a deployment
that only *looks* like a Test Manager never wins, two matches never guess, and
the probe never carries a credential.

**The round-trip group** routes `_http` into the real app. It proves that the
body this helper builds passes the real provenance gate, mints version 1,
replays at 200, and that the multipart envelope the helper writes by hand
really parses on `POST /results/upload`.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from urllib.parse import urlsplit

import pytest

from notebooks import publish_result as pr
from tests import factories_results
from tests.conftest import TEST_TOKEN
from tests.factories_results import RUN_ID

results_db = factories_results.results_db

PORTAL = "https://portal-api.test.quix.io"
WORKSPACE = "org-demo-tests"
TM_ROOT = "https://test-manager-api-org-demo-tests.deployments.quix.io"
QUIXLAB_ROOT = "https://quixlab-org-demo-tests.deployments.quix.io"
FRONTEND_ROOT = "https://test-manager-org-demo-tests.deployments.quix.io"


# --- Portal and probe doubles -------------------------------------------------


def deployment(name: str, url: str, **overrides) -> dict:
    """One row of the Portal's deployment list, in the Portal's own spelling."""
    row = {
        "deploymentId": f"dep-{name}",
        "name": name,
        "deploymentType": "Service",
        "status": "Running",
        "publicUrl": url,
        "libraryItemId": "",
    }
    row.update(overrides)
    return row


def openapi(title: str = pr.API_TITLE, paths: Iterable[str] = pr.PROOF_PATHS) -> bytes:
    """A schema document, as the open `/openapi.json` route answers it."""
    return json.dumps(
        {"openapi": "3.1.0", "info": {"title": title}, "paths": {p: {} for p in paths}}
    ).encode()


class Network:
    """A fake network. It answers the Portal call and every probe, and it
    records every request so a test can prove what travelled."""

    def __init__(self, rows: list[dict], schemas: dict[str, bytes] | None = None):
        self.rows = rows
        self.schemas = schemas or {}
        self.calls: list[tuple[str, str, dict]] = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, dict(headers)))
        if url.startswith(PORTAL):
            return 200, json.dumps(self.rows).encode()
        for root, payload in self.schemas.items():
            if url == root + pr.OPENAPI_PATH:
                return 200, payload
        return 404, b"not found"

    def probe_headers(self) -> list[dict]:
        return [h for _m, u, h in self.calls if u.endswith(pr.OPENAPI_PATH)]


@pytest.fixture
def platform(monkeypatch):
    """Set the two names the platform injects, and clear every token name."""
    monkeypatch.setenv(pr.PORTAL_API_VAR, PORTAL)
    monkeypatch.setenv(pr.WORKSPACE_VAR, WORKSPACE)
    for name in pr.TOKEN_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("QUIX_PAT_TOKEN", TEST_TOKEN)


def install(monkeypatch, network: Network) -> Network:
    monkeypatch.setattr(pr, "_http", network)
    return network


# --- the match rule -----------------------------------------------------------


def test_one_test_manager_wins_and_prints_only_its_name(platform, monkeypatch, capsys):
    """Exactly one match asks nothing and says one thing: the chosen name."""
    install(
        monkeypatch,
        Network(
            [
                deployment("Test Manager API", TM_ROOT),
                deployment("Test Manager Frontend", FRONTEND_ROOT),
                deployment("QuixLab", QUIXLAB_ROOT, libraryItemId="quixlab"),
            ],
            {TM_ROOT: openapi()},
        ),
    )

    assert pr.find_test_manager() == TM_ROOT
    assert capsys.readouterr().out == "Test Manager API\n"


def test_the_probe_carries_no_credential(platform, monkeypatch):
    """The token reaches a host only after the proof holds, never before.

    This is the whole safety of the match: a wrong guess costs one bare GET.
    """
    network = install(
        monkeypatch,
        Network(
            [deployment("Test Manager API", TM_ROOT), deployment("Other", FRONTEND_ROOT)],
            {TM_ROOT: openapi()},
        ),
    )

    pr.find_test_manager(quiet=True)

    assert network.probe_headers(), "the rule must probe, not guess"
    for headers in network.probe_headers():
        assert "Authorization" not in headers


def test_a_deployment_named_like_us_is_not_a_match(platform, monkeypatch):
    """A label never decides. Only the two routes do."""
    install(
        monkeypatch,
        Network(
            [deployment("Test Manager API", FRONTEND_ROOT)],
            {FRONTEND_ROOT: openapi(title="Some Other Service")},
        ),
    )

    with pytest.raises(pr.PublishError, match="no deployment"):
        pr.find_test_manager(quiet=True)


def test_a_schema_missing_the_upload_route_is_not_a_match(platform, monkeypatch):
    """A match must serve BOTH routes this helper posts to."""
    install(
        monkeypatch,
        Network(
            [deployment("Test Manager API", TM_ROOT)],
            {TM_ROOT: openapi(paths=[pr.RESULTS_PATH])},
        ),
    )

    with pytest.raises(pr.PublishError, match="no deployment"):
        pr.find_test_manager(quiet=True)


def test_a_renamed_test_manager_still_wins(platform, monkeypatch, capsys):
    """A person may rename the deployment. The routes still prove it."""
    install(
        monkeypatch,
        Network([deployment("Volvo registry", TM_ROOT)], {TM_ROOT: openapi()}),
    )

    assert pr.find_test_manager() == TM_ROOT
    assert capsys.readouterr().out == "Volvo registry\n"


def test_two_matches_raise_with_both_names(platform, monkeypatch):
    """More than one, and no hint separates them, never guesses."""
    second = "https://test-manager-api-2-org.deployments.quix.io"
    install(
        monkeypatch,
        Network(
            [
                deployment("Test Manager API", TM_ROOT, applicationId="api"),
                deployment("Staging Test Manager API", second, applicationId="api"),
            ],
            {TM_ROOT: openapi(), second: openapi()},
        ),
    )

    with pytest.raises(pr.PublishError) as error:
        pr.find_test_manager(quiet=True)

    message = str(error.value)
    assert "Test Manager API" in message
    assert "Staging Test Manager API" in message
    assert "base_url" in message


def test_the_application_id_breaks_a_tie(platform, monkeypatch, capsys):
    """A front end that also served the schema must not win the write."""
    install(
        monkeypatch,
        Network(
            [
                deployment("Test Manager - API", TM_ROOT, applicationId="api"),
                deployment("Test Manager", FRONTEND_ROOT, applicationId="frontend"),
            ],
            {TM_ROOT: openapi(), FRONTEND_ROOT: openapi()},
        ),
    )

    assert pr.find_test_manager() == TM_ROOT
    assert capsys.readouterr().out == "Test Manager - API\n"


def test_the_name_breaks_a_tie_when_no_application_id_does(platform, monkeypatch, capsys):
    """The deployment name is the last resort, and it reads the word, not a string.

    The real workspace holds "Test Manager - API" and `quix.yaml` writes
    "Test Manager API", so an exact string match would fail on one of them.
    """
    install(
        monkeypatch,
        Network(
            [
                deployment("Test Manager - API", TM_ROOT, applicationId=""),
                deployment("Test Manager", FRONTEND_ROOT, applicationId=""),
            ],
            {TM_ROOT: openapi(), FRONTEND_ROOT: openapi()},
        ),
    )

    assert pr.find_test_manager() == TM_ROOT
    assert capsys.readouterr().out == "Test Manager - API\n"


def test_a_hint_never_decides_on_its_own(platform, monkeypatch):
    """The application id and the name only choose between PROVED Test Managers.

    Here the API-shaped deployment fails the probe. The hint must not rescue it,
    and the helper must answer "none" rather than pick it.
    """
    install(
        monkeypatch,
        Network(
            [
                deployment("Test Manager - API", TM_ROOT, applicationId="api"),
                deployment("Something else", FRONTEND_ROOT, applicationId="frontend"),
            ],
            {},
        ),
    )

    with pytest.raises(pr.PublishError, match="no deployment"):
        pr.find_test_manager(quiet=True)


def test_no_match_names_what_to_check(platform, monkeypatch):
    install(monkeypatch, Network([deployment("QuixLab", QUIXLAB_ROOT)], {}))

    with pytest.raises(pr.PublishError) as error:
        pr.find_test_manager(quiet=True)

    message = str(error.value)
    assert WORKSPACE in message
    assert "public access" in message


def test_a_quixlab_row_is_never_probed(platform, monkeypatch):
    """The page this cell runs on is never the target of the write."""
    network = install(
        monkeypatch,
        Network(
            [
                deployment("QuixLab", QUIXLAB_ROOT, libraryItemId="QuixLab"),
                deployment("Test Manager API", TM_ROOT),
            ],
            {TM_ROOT: openapi()},
        ),
    )

    pr.find_test_manager(quiet=True)

    assert all(QUIXLAB_ROOT not in url for _m, url, _h in network.calls)


def test_a_job_is_never_probed(platform, monkeypatch):
    """A Job serves no HTTP route, so it never reaches the network."""
    network = install(
        monkeypatch,
        Network(
            [
                deployment("Test Manager Seed", FRONTEND_ROOT, deploymentType="Job"),
                deployment("Test Manager API", TM_ROOT),
            ],
            {TM_ROOT: openapi()},
        ),
    )

    pr.find_test_manager(quiet=True)

    assert all(FRONTEND_ROOT not in url for _m, url, _h in network.calls)


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "https://tm.example.com/?token=abc",
        "https://user:pass@tm.example.com/",
        "https://tm.example.com/#frag",
        "",
    ],
)
def test_an_unusable_public_url_never_reaches_the_network(platform, monkeypatch, url):
    """The same four-part proof `api/api/quixlab.py` applies, applied here."""
    network = install(
        monkeypatch,
        Network(
            [deployment("Odd", url), deployment("Test Manager API", TM_ROOT)],
            {TM_ROOT: openapi()},
        ),
    )

    pr.find_test_manager(quiet=True)

    probed = [u for _m, u, _h in network.calls if u.endswith(pr.OPENAPI_PATH)]
    assert probed == [TM_ROOT + pr.OPENAPI_PATH]


def test_a_portal_denial_of_200_false_is_never_read_as_a_list(platform, monkeypatch):
    """The Portal answers a denial with 200 and the body `false`. Read the body."""

    def portal_says_false(method, url, headers, body, timeout):
        return 200, b"false"

    monkeypatch.setattr(pr, "_http", portal_says_false)

    with pytest.raises(pr.PublishError, match="did not answer with a deployment list"):
        pr.find_test_manager(quiet=True)


def test_a_portal_refusal_names_the_fix(platform, monkeypatch):
    def portal_refuses(method, url, headers, body, timeout):
        return 401, b""

    monkeypatch.setattr(pr, "_http", portal_refuses)

    with pytest.raises(pr.PublishError, match="refused to list this workspace"):
        pr.find_test_manager(quiet=True)


def test_no_portal_url_names_both_variables(monkeypatch):
    monkeypatch.delenv(pr.PORTAL_API_VAR, raising=False)
    monkeypatch.setenv(pr.WORKSPACE_VAR, WORKSPACE)

    with pytest.raises(pr.PublishError) as error:
        pr.find_test_manager(token="t", quiet=True)

    assert pr.PORTAL_API_VAR in str(error.value)
    assert pr.WORKSPACE_VAR in str(error.value)


def test_a_dead_deployment_does_not_stop_the_publish(platform, monkeypatch):
    """One pod that never answers must not hide the live Test Manager."""

    def flaky(method, url, headers, body, timeout):
        if url.startswith(PORTAL):
            return 200, json.dumps(
                [deployment("Dead", FRONTEND_ROOT), deployment("Test Manager API", TM_ROOT)]
            ).encode()
        if url.startswith(FRONTEND_ROOT):
            raise pr.PublishError("GET did not answer: TimeoutError")
        return 200, openapi()

    monkeypatch.setattr(pr, "_http", flaky)

    assert pr.find_test_manager(quiet=True) == TM_ROOT


# --- the token ----------------------------------------------------------------


def test_the_viewer_session_beats_the_latest_session(monkeypatch):
    """`current_token()` reads the LATEST session, which may be another viewer."""
    monkeypatch.setattr(pr, "_token_from_viewer_session", lambda: "this-viewer")
    monkeypatch.setattr(pr, "_token_from_quixlab_chain", lambda: "")
    monkeypatch.setattr(pr, "_token_from_latest_session", lambda: "some-other-viewer")

    assert pr.viewer_token() == "this-viewer"


def test_the_environment_is_the_last_resort(monkeypatch):
    for name in pr.TOKEN_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("Quix__Sdk__Token", "sdk")
    monkeypatch.setenv("QUIX_PAT_TOKEN", "pat")
    for name in ("_token_from_viewer_session", "_token_from_quixlab_chain",
                 "_token_from_latest_session"):
        monkeypatch.setattr(pr, name, lambda: "")

    # An explicit PAT beats the SDK token the platform injects everywhere.
    assert pr.viewer_token() == "pat"


def test_no_token_raises_and_the_message_names_no_credential(monkeypatch):
    for name in pr.TOKEN_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    for name in ("_token_from_viewer_session", "_token_from_quixlab_chain",
                 "_token_from_latest_session"):
        monkeypatch.setattr(pr, name, lambda: "")

    with pytest.raises(pr.PublishError) as error:
        pr.viewer_token()

    assert "QUIX_PAT_TOKEN" in str(error.value)


def test_a_non_ascii_token_is_refused_and_never_repeated(monkeypatch):
    """A header must encode to latin-1, so such a token cannot leave the process."""
    monkeypatch.setattr(pr, "_token_from_viewer_session", lambda: "tökén")

    with pytest.raises(pr.PublishError) as error:
        pr.viewer_token()

    assert "tökén" not in str(error.value)


def test_no_error_of_the_discovery_path_repeats_the_token(platform, monkeypatch):
    """Sweep: every refusal message this path can write, checked for the token."""
    secret = "super-secret-viewer-token"
    monkeypatch.setenv("QUIX_PAT_TOKEN", secret)
    for answer in ((401, b""), (500, b""), (200, b"false"), (200, b"{}")):
        monkeypatch.setattr(pr, "_http", lambda *a, _r=answer, **k: _r)
        with pytest.raises(pr.PublishError) as error:
            pr.find_test_manager(quiet=True)
        assert secret not in str(error.value)


# --- the body -----------------------------------------------------------------


def kwargs(**overrides) -> dict:
    body = {
        "result_key": "cycle-summary",
        "name": "Cycle summary",
        "tool": "quixlab-notebook",
        "tool_version": "1.0.0",
        "parameters": "window=cycle",
        "input_file_ids": [],
        "produced_by": "Luis Masiá",
    }
    body.update(overrides)
    return body


def test_the_body_carries_all_six_provenance_fields(monkeypatch):
    monkeypatch.setattr(pr, "_current_run", lambda: RUN_ID)

    body = pr.build_body(**kwargs())

    assert set(body["provenance"]) == set(factories_results.PROVENANCE_KEYS)
    assert body["run_id"] == RUN_ID
    assert body["provenance"]["produced_at"].endswith("Z")


def test_the_run_id_comes_from_the_imported_session(monkeypatch):
    """The Test Manager already sent the run, and QuixLab already stored it."""
    monkeypatch.setattr(pr, "_current_run", lambda: "TAS-90011")

    assert pr.build_body(**kwargs())["run_id"] == "TAS-90011"


def test_an_explicit_run_id_beats_the_session(monkeypatch):
    monkeypatch.setattr(pr, "_current_run", lambda: "TAS-90011")

    assert pr.build_body(**kwargs(run_id="TAS-1"))["run_id"] == "TAS-1"


def test_no_run_anywhere_raises_and_names_the_fix(monkeypatch):
    monkeypatch.setattr(pr, "_current_run", lambda: "")

    with pytest.raises(pr.PublishError, match="run_id"):
        pr.build_body(**kwargs())


def test_the_body_never_carries_a_storage_ref(monkeypatch):
    """The upload route mints it, and a supplied one answers 422."""
    monkeypatch.setattr(pr, "_current_run", lambda: RUN_ID)

    assert "storage_ref" not in pr.build_body(**kwargs())


# --- what the API answers -----------------------------------------------------


def test_a_replay_of_200_is_an_answer_and_not_a_fault():
    stored = {"result_id": "res-1", "version": 1}

    assert pr._read_answer(200, json.dumps(stored).encode(), "POST") == stored


def test_a_409_names_the_conflict_and_never_retries():
    payload = json.dumps({"message": "another write holds this result version",
                          "code": "version_conflict"}).encode()

    with pytest.raises(pr.PublishError) as error:
        pr._read_answer(409, payload, "POST /results")

    assert "version_conflict" in str(error.value)
    assert "before you retry" in str(error.value)


def test_a_422_repeats_the_api_code():
    payload = json.dumps({"message": "provenance.tool is required",
                          "code": "provenance_required"}).encode()

    with pytest.raises(pr.PublishError, match="provenance_required"):
        pr._read_answer(422, payload, "POST /results")


# --- the multipart envelope ---------------------------------------------------


def test_a_file_name_cannot_forge_a_second_part():
    """A quote would close the header early, so the name is refused, not escaped."""
    with pytest.raises(pr.PublishError, match="no quote"):
        pr._multipart('evil"; name="metadata', b"x", "{}")


def test_the_envelope_holds_both_parts():
    content_type, body = pr._multipart("/tmp/summary.parquet", b"BYTES", '{"a":1}')

    assert content_type.startswith("multipart/form-data; boundary=")
    assert b'name="metadata"' in body
    assert b'filename="summary.parquet"' in body
    assert b"BYTES" in body


def test_an_oversized_file_never_leaves_this_process(monkeypatch, tmp_path):
    """The server owns the cap. This only stops a doomed upload early."""
    monkeypatch.setattr(pr, "MAX_UPLOAD_BYTES", 8)
    path = tmp_path / "big.bin"
    path.write_bytes(b"0123456789")

    def never(*args, **kwargs):
        raise AssertionError("no byte may leave")

    monkeypatch.setattr(pr, "_http", never)

    with pytest.raises(pr.PublishError, match="the cap is 8"):
        pr.publish_result_file(path=str(path), base_url=TM_ROOT, **kwargs(run_id=RUN_ID))


# --- the round trip, against the real app -------------------------------------


@pytest.fixture
def routed_http(monkeypatch, client):
    """Send every call the helper makes into the real app, over the real routes."""

    def through_the_app(method, url, headers, body, timeout):
        sent = {k: v for k, v in headers.items() if k.lower() != "content-length"}
        response = client.request(method, urlsplit(url).path, content=body, headers=sent)
        return response.status_code, response.content

    monkeypatch.setattr(pr, "_http", through_the_app)
    monkeypatch.setattr(pr, "_current_run", lambda: RUN_ID)
    monkeypatch.setattr(pr, "viewer_token", lambda: TEST_TOKEN)


def test_post_results_stores_version_one_and_a_replay_mints_none(results_db, routed_http):
    """The helper's own body passes the real gate, and a retry is safe."""
    fixed = "2026-08-28T09:00:00Z"
    first = pr.publish_result(base_url="http://testserver", produced_at=fixed, **kwargs())

    assert first["version"] == 1
    assert first["provenance_status"] == "flagged"  # no input file named
    assert first["provenance"]["tool"] == "quixlab-notebook"

    again = pr.publish_result(base_url="http://testserver", produced_at=fixed, **kwargs())

    assert again["result_id"] == first["result_id"]
    assert results_db["processed_results"].count_documents({}) == 1


def test_a_named_input_file_reads_as_verified(results_db, routed_http):
    stored = factories_results.seed_file(results_db)

    answer = pr.publish_result(
        base_url="http://testserver", **kwargs(input_file_ids=[stored["_id"]])
    )

    assert answer["provenance_status"] == "verified"


def test_a_blank_provenance_field_is_still_refused(results_db, routed_http):
    """The gate is the server's. The helper must not paper over it."""
    with pytest.raises(pr.PublishError, match="provenance_required"):
        pr.publish_result(base_url="http://testserver", **kwargs(tool_version="  "))


def test_the_upload_envelope_parses_and_the_row_names_the_bytes(
    results_db, routed_http, override_writer, tmp_path
):
    """The hand-written multipart body really reaches the real route."""
    writer = override_writer(_Memory())
    path = tmp_path / "cycle-summary.csv"
    path.write_bytes(b"cycle,peak\n1,41.2\n")

    answer = pr.publish_result_file(path=str(path), base_url="http://testserver", **kwargs())

    assert answer["storage_ref"].startswith("blob://")
    assert list(writer.stored.values()) == [b"cycle,peak\n1,41.2\n"]
    entries = list(results_db["journal_entries"].find({"field": "run.result_uploaded"}))
    assert len(entries) == 1


class _Memory:
    """A writer that keeps the bytes, so a test can read them back."""

    def __init__(self) -> None:
        self.stored: dict[str, bytes] = {}

    def check_ready(self) -> None:
        return None

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        data = b"".join(chunks)
        self.stored[key] = data
        return len(data)


@pytest.fixture
def override_writer(app):
    from api.services import file_writes

    def install(writer):
        app.dependency_overrides[file_writes.get_file_writer] = lambda: writer
        return writer

    yield install
    app.dependency_overrides.pop(file_writes.get_file_writer, None)
