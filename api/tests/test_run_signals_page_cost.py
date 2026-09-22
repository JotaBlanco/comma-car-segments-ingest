# GET /test-runs/{run_id}/signals costs the PAGE, not the run.

import pytest

from tests import factories, factories_signals
from tests.factories_signals import make_file_signal

signals_db = factories_signals.signals_db

RUN = "TAS-88214"
FILES = ("f-a", "f-b", "f-c")
# Page sizes start at ten, so the run needs more than ten.
PAGE_SIZE = 10
NAMES = tuple(f"Sig_{index:03d}" for index in range(24))


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. The suite runs no real lake."""


@pytest.fixture
def counted_reads(monkeypatch):
    """Count the file_signals documents any find() hands back to the service.

    The patch sits on the class, so it sees the collection the app itself
    holds and not a second handle onto the same name.
    """
    from pymongo.synchronous.collection import Collection

    original = Collection.find
    seen: list[int] = []

    def counting_find(self, *args, **kwargs):
        cursor = original(self, *args, **kwargs)
        if self.name != "file_signals":
            return cursor
        rows = list(cursor)
        seen.append(len(rows))
        return iter(rows)

    monkeypatch.setattr(Collection, "find", counting_find)
    return seen


def _seed(db) -> None:
    factories.upsert_run(db)
    for file_id in FILES:
        factories.register_file(db, _id=file_id)
    for name in NAMES:
        for file_id in FILES:
            make_file_signal(db, file_id, name)


def test_a_page_reads_only_the_rows_of_its_own_signals(client, signals_db, counted_reads):
    _seed(signals_db)

    resp = client.get(f"/api/v1/test-runs/{RUN}/signals", params={"page_size": PAGE_SIZE})
    assert resp.status_code == 200, (resp.status_code, resp.text[:400])
    body = resp.json()

    assert [item["name"] for item in body["items"]] == list(NAMES[:PAGE_SIZE])
    assert body["total"] == len(NAMES)
    # Ten signals over three files is thirty rows, not 72.
    assert max(counted_reads) <= len(FILES) * PAGE_SIZE
