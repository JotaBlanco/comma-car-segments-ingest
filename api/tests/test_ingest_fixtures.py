"""The demo measurement byte mint (B-15, reworked 2026-08-19).

`ingest/fixtures.py` mints one small, real MF4 object in memory.
`ingest/blob_seed.py` writes those bytes at each registered file's
`storage_ref`, so the download button serves a real measurement file on a
developer machine. These checks need no Docker, no Mongo and no store.

**The landing drop left on 19 Aug 2026.** This file used to prove a demo drop
into the prefix the watcher polled, and it drove a stage rehearsal through the
real `POST /files`. The watcher moved to the ingestion pipeline
(`plans/design/INGEST-SPLIT.md`), and `write_all`, `write_fixture` and `main`
left with it. What stays is the byte mint and the small store writer that
`blob_seed.py` calls.

The fixtures never enter git. `ingest/fixtures.py` mints them, and `.gitignore`
excludes `*.mf4` and `landing_zone/`.
"""

import io
from datetime import UTC, datetime, timedelta

import pytest

from ingest.fixtures import (
    FIXTURES,
    SAMPLE_COUNT,
    START_TIME,
    mf4_bytes,
    put_object,
)

# --- the byte mint, with no server ---------------------------------------------------


def test_the_recipe_mints_three_fixtures():
    """Two to three fixtures carry the beat. The sheet asks for three."""
    assert len(FIXTURES) == 3
    assert len({f.key for f in FIXTURES}) == 3
    assert len({f.run_id for f in FIXTURES}) == 3


def test_the_start_time_lands_inside_todays_window():
    """`START_TIME` rebases on import, so a minted run counts under "runs today".

    `home_summary` bounds today at both ends: `[midnight, midnight + 1 day)`.
    A pinned date of 2026-08-14 fell outside that window on every later day.
    """
    now = datetime.now(UTC)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)

    assert midnight <= START_TIME < midnight + timedelta(days=1)
    assert START_TIME <= now, "a future start time counts as no day at all"


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f.run_id)
def test_every_fixture_mints_a_real_readable_mdf(fixture):
    """`asammdf` reads the bytes the mint writes, and the header states the truth.

    Two earlier tests held this guard through the watcher's own parser. That
    parser left with the watcher on 19 Aug 2026, so this test opens the bytes
    with `asammdf` directly. `asammdf` stays in the `ingest` dependency group.

    A file without a start time writes no lake row, so the start time is a
    guard and not a detail.
    """
    from asammdf import MDF

    mdf = MDF(io.BytesIO(mf4_bytes(fixture)))
    try:
        assert mdf.version.startswith("4"), "the mint must write MDF 4"

        channels = [
            channel for channel in mdf.iter_channels() if channel.name != "time"
        ]
        start = mdf.header.start_time
    finally:
        mdf.close()

    assert [channel.name for channel in channels] == [
        name for name, _unit in fixture.channels
    ]

    if start.tzinfo is None:
        start = start.replace(tzinfo=UTC)
    assert start.astimezone(UTC) == START_TIME

    assert [len(channel.samples) for channel in channels] == [SAMPLE_COUNT] * len(
        fixture.channels
    )


def test_a_fixture_stays_small_enough_for_a_live_drop():
    """A demo drop must register while the audience watches."""
    assert len(mf4_bytes(FIXTURES[0])) < 200_000


def test_one_process_mints_one_byte_image_per_fixture():
    """The re-drop beat needs the same bytes, and asammdf does not give them.

    asammdf writes three bytes that change on every save, measured 2026-08-17.
    Two mints are therefore two different files, and the server registers both,
    correctly. The generator caches the byte image, so a re-drop is a re-drop.
    """
    assert mf4_bytes(FIXTURES[0]) is mf4_bytes(FIXTURES[0])


def test_the_recipe_refuses_a_store_it_does_not_know():
    """The writer names the two stores it supports and refuses anything else."""
    with pytest.raises(TypeError):
        put_object(object(), "k", b"x")


def test_the_demo_drop_never_names_the_seed_hero_pair():
    """One `run_id,signal` partition takes one writer, never two.

    The seed writes lake rows for the hero signal on the hero run
    (`seed/fixtures_inventory.py`). A demo fixture that carries the same
    channel for the same run lands 1000 real samples in that same partition,
    and the statistics query then averages a measurement with a synthetic set.

    Measured on 18 August 2026, before the fix: the API served mean
    32.21962913255753 and the seed's max, where the file alone gives
    32.203103940413335 and its own max. File detail served the seed numbers at
    the same moment, so two screens stated two numbers for one run.
    """
    from seed.fixtures_inventory import HERO_RUN_ID, HERO_SIGNAL_NAME

    clashes = [
        (fixture.run_id, name)
        for fixture in FIXTURES
        for name, _unit in fixture.channels
        if fixture.run_id == HERO_RUN_ID and name == HERO_SIGNAL_NAME
    ]

    assert clashes == [], f"the demo fixtures write into a seeded partition: {clashes}"
