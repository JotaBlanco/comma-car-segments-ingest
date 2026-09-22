"""Demo dressing: a run that arrives with no rig SOMETIMES gets one.

The importer sends bytes and a run id — no rig, operator, cell or bench
software — so every importer-fed run reads UNKNOWN on the runs screen. For
the demo the estate should look lived-in, but the honest-UNKNOWN beat (a
person corrects a run the pipeline refused to guess about, and the journal
shows the edit) must survive. So the dressing is probabilistic: roughly
three undressed runs in four are dressed from the bench's own world, and the
rest keep their honest UNKNOWN.

The dice are DETERMINISTIC — sha1 of the run id — never `random`: Kafka
redelivers, both connector lanes upsert the same run, and a re-upload under
the same id replays. A coin flipped per delivery would flip the rig between
upserts of one run. Same run id, same answer, forever.

Dressing fills silence only. A file that states its own rig is never
touched, and a stated operator/cell/bench_sw survives on a dressed run —
the "never invent" rule bends exactly here, visibly, and nowhere else.
"""

import hashlib

from connector.identity import UNKNOWN_RIG

# One undressed run in HONEST_ONE_IN keeps its honest UNKNOWN.
HONEST_ONE_IN = 4

# The bench's own rig pool (test-bench/generation.py:52), each in a fixed
# cell so the pairing reads coherent (the seed places RIG-04 in TC-2,
# api/seed/fixtures.py).
RIG_CELLS = (
    ("RIG-01", "TC-1"),
    ("RIG-02", "TC-1"),
    ("RIG-04", "TC-2"),
    ("RIG-07", "TC-3"),
)

OPERATORS = ("A. Bergström", "E. Nilsson", "J. Lindqvist", "P. Andersson")

# The estate's own bench-software family, NOT a family of this module's
# invention: the seed states "TAS 7.4.1 · fw 2.10" / "TAS 7.4.2 · fw 2.11"
# (api/seed/fixtures.py:71, :322) and the edit dialog advertises that exact
# shape as its placeholder. A dressed run sits in the same table as seeded
# ones, so a version three majors behind in a different format is the first
# thing an engineer in the audience notices.
BENCH_SOFTWARE = ("TAS 7.4.1 · fw 2.10", "TAS 7.4.2 · fw 2.11", "TAS 7.4.3 · fw 2.12")


def dress_run_body(body: dict) -> dict:
    """Fill an UNKNOWN-rig run body from the pools — or leave it honest.

    Applied by `bodies.run_body`, the one builder both lanes share, so the
    metadata-time upsert and the file-complete upsert of a run always agree.
    Mutates and returns the body.
    """
    run_id = body.get("run_id")
    if not run_id or body.get("rig_id") != UNKNOWN_RIG:
        return body

    digest = hashlib.sha1(str(run_id).encode("utf-8")).digest()
    if digest[0] % HONEST_ONE_IN == 0:
        return body  # the honest quarter

    rig, cell = RIG_CELLS[digest[1] % len(RIG_CELLS)]
    body["rig_id"] = rig
    body.setdefault("test_cell", cell)
    body.setdefault("operator", OPERATORS[digest[2] % len(OPERATORS)])
    body.setdefault("bench_sw", BENCH_SOFTWARE[digest[3] % len(BENCH_SOFTWARE)])
    return body
