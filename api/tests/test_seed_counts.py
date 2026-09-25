"""The printed seed report must agree with the database.

The seed prints one line per collection. A person re-seeds on the demo morning,
reads that report and decides the seed is good. So a count that leaves out the
filler is worse than no count: it says the seed under-ran when it did not.

The database mechanism is the shared one from `conftest.py`. This module adds no
second one.
"""

import pytest

from seed import seed_demo

# The scale the demo seed writes, stated by hand. The seed tops the filler up to
# its own DEMO_WORK_ORDER_COUNT, so a test that reads that constant back compares
# the seed with itself and passes whatever the seed does. These are the numbers
# the demo screens quote: 42 work orders in all, 5 of them mirrored from
# planning and 1 opened by the hero's own upload.
DEMO_WORK_ORDERS = 42
NAMED_WORK_ORDERS = 5

# The hero run's own inventory. Three files land on it; the fourth seeded file
# is the quarantine case and names no run.
HERO_RUN = "TAS-88214"
HERO_FILES = 3
HERO_SIGNALS = 11
HERO_ROWS = 12


@pytest.fixture
def planning(planning_offline):
    """The shared override fixture, by the name the seed tests use."""
    return planning_offline


def test_the_report_counts_every_work_order_the_seed_wrote(client, routed_db, planning) -> None:
    """Five mirrors, one the hero's upload opened, 36 from the filler. The
    report must state all of them."""
    counts = seed_demo.seed(
        routed_db, client, reset=True, inventory=False, filler_records=True
    )

    assert counts["work_orders"] == routed_db["work_orders"].count_documents({})
    assert counts["work_orders"] == DEMO_WORK_ORDERS


def test_a_re_seed_reports_no_new_filler_work_order(client, routed_db, planning) -> None:
    """The count means "written", not "present". A second run writes none.

    The hero's campaign already exists by then, so the registration opens
    nothing and only the five mirror rows are restated.
    """
    first = seed_demo.seed(
        routed_db, client, reset=True, inventory=False, filler_records=True
    )
    stored = routed_db["work_orders"].count_documents({})

    second = seed_demo.seed(routed_db, client, inventory=False, filler_records=True)

    assert first["work_orders"] == stored
    assert second["work_orders"] == NAMED_WORK_ORDERS
    assert routed_db["work_orders"].count_documents({}) == stored


# --- R-01: the report must agree with what the routes serve ---
#
# `test_seed_final.py` already holds the database-side equality over every
# seeded run: `test_every_stored_run_count_matches_the_seeded_inventory`. A
# second copy of it would cost another full seed and prove nothing new. What
# no test held is the SERVED pair — the numbers a viewer reads on the demo
# morning, through the routes, over the seeded hero run.


def test_the_hero_run_serves_the_counts_its_drill_downs_find(
    client, routed_db, planning
) -> None:
    """The seeded hero run, read the way a viewer reads it on the demo."""
    seed_demo.seed(routed_db, client, reset=True, inventory=True, filler_records=False)

    run = client.get(f"/api/v1/test-runs/{HERO_RUN}").json()
    files = client.get(f"/api/v1/test-runs/{HERO_RUN}/files").json()

    assert run["file_count"] == files["total"] == HERO_FILES
    assert run["signal_count"] == HERO_SIGNALS

    # The badge counts NAMES, not rows. Chamber_Ambient_Temp sits in two of
    # the three files, so the run holds 12 inventory rows and 11 signals.
    assert routed_db["file_signals"].count_documents({"run_id": HERO_RUN}) == HERO_ROWS
    assert (
        len(routed_db["file_signals"].distinct("name", {"run_id": HERO_RUN}))
        == HERO_SIGNALS
    )
