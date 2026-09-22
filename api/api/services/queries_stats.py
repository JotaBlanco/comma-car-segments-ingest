"""Lane B statistics queries: the per-run signal merge and the cross-run stats.

The file aggregations live here, apart from services/queries_signals.py, so the
files tickets and the statistics tickets never touch the same module.
"""

import logging
import math
import os

from pymongo import DESCENDING
from pymongo.database import Database

from api.errors import ApiError
from api.models.common import Pagination, Source
from api.provenance import blocks, derive_status
from api.services import lake

logger = logging.getLogger(__name__)

# The largest file of the run wins these fields.
_METADATA_FIELDS = ("unit", "unit_source", "rate_hz", "dtype")

# The lake table holds the parsed samples. Prior art: mdf_file_test, which
# partitions by file_name then channel and carries timestamp and value.
_DEFAULT_LAKE_TABLE = "test_signal_samples"

# The four quantities every measured block states. A row that misses one of
# them is not measured at all.
_STAT_FIELDS = ("min", "max", "mean", "std")

# The other four quantities FR-DM-014 names. Each one is optional on both
# sides: a producer may state none of them, and a null percentile must never
# cost the row its four core numbers. They stay apart from _STAT_FIELDS for
# exactly that reason.
_RMS_FIELD = "rms"
_PERCENTILE_FIELDS = ("p50", "p95", "p99")
_OPTIONAL_STAT_FIELDS = (_RMS_FIELD, *_PERCENTILE_FIELDS)

# The key a per-file stats block carries to state how many samples it
# measured. It is the only honest weight for a merge. See _sample_count.
_COUNT_FIELD = "sample_count"


def run_exists(db: Database, run_id: str) -> bool:
    """Report whether the data knows this run.

    The run document belongs to lane A. A registered file or a signal row that
    names the run also proves it exists.
    """
    for collection, query in (
        ("test_runs", {"_id": run_id}),
        ("files", {"run_id": run_id}),
        ("file_signals", {"run_id": run_id}),
    ):
        if db[collection].count_documents(query, limit=1):
            return True
    return False


def _file_weights(db: Database, file_ids: set[str]) -> dict[str, int]:
    """Rank each file by its byte size. A missing size ranks one.

    This picks the largest file, which wins the metadata fields. It never
    weighs a statistic: a byte size is not a sample count. See _merge_stats.
    """
    found = db["files"].find({"_id": {"$in": list(file_ids)}}, {"size_bytes": 1})
    return {file["_id"]: file.get("size_bytes") or 1 for file in found}


def _ranked(rows: list[dict]) -> list[dict]:
    """Rank one signal's file rows, largest file first."""
    return sorted(rows, key=lambda row: (-row["weight"], row["file_id"]))


def _inventory(rows: list[dict]) -> dict:
    """Describe one signal from the registry. The largest file wins each field.

    This half is registry data: which signal, in what unit, at what rate. It
    stays in Mongo whichever side serves the numbers.
    """
    largest = _ranked(rows)[0]
    return {
        "name": largest["name"],
        "stats": None,
        **{field: largest.get(field) for field in _METADATA_FIELDS},
    }


def _sample_count(row: dict) -> int | None:
    """Read the sample count of one file's statistics block, or answer None.

    `SignalStatsInput` takes an optional `sample_count`, so a producer that
    measures one states it and the merge below is then exact. A block from an
    older producer holds no count, and this answers None for it.

    A count below one is not a count, so it reads as absent and the signal
    falls to the lake. The model takes any integer on purpose: a bound there
    would answer 422 and cost every other signal of the body its row.

    Never derive a count from the rate or from the file size. A guessed weight
    is a wrong number that looks like a right one.
    """
    count = row["stats"].get(_COUNT_FIELD)
    if isinstance(count, bool) or not isinstance(count, (int, float)):
        return None
    if not math.isfinite(count) or count < 1:
        return None
    return int(count)


def _optional_number(block: dict, field: str) -> float | None:
    """Read one optional quantity of a statistics block, or answer None.

    A key that is absent, null, a boolean, a text or a NaN is not a number.
    It answers None, and the field then lists blank. It never costs the block
    its four core numbers.
    """
    value = block.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return float(value)


def _pooled_rms(counts: list[int], measured: list[dict]) -> float | None:
    """Merge the RMS of one signal over the files of a run, or answer None.

    The RMS is the square root of a MEAN OF SQUARES, so the merge is exact:

        rms = sqrt( SUM n_i * rms_i^2 / SUM n_i )

    Every file must state its own RMS. One file without it describes a part
    of the run, and a part served as the whole is a wrong number that looks
    like a right one, so this answers None and the field lists blank.
    """
    squares = 0.0
    for count, row in zip(counts, measured):
        value = _optional_number(row["stats"], _RMS_FIELD)
        if value is None:
            return None
        squares += count * value * value
    return math.sqrt(squares / sum(counts))


def _stated(block: dict, fields: tuple[str, ...]) -> dict:
    """Pass the optional quantities of ONE file's block through the merge.

    One measured file needs no merge: its own numbers already describe the
    run. A quantity it did not state stays absent, so the row lists blank.
    """
    found = {field: _optional_number(block, field) for field in fields}
    return {field: value for field, value in found.items() if value is not None}


def _merge_stats(rows: list[dict]) -> dict | None:
    """Merge one signal's measured statistics across the run's files.

    The pipeline measures each signal as it passes and states the four numbers
    on the inventory row. A block that is present was measured, so this reads
    it. No flag turns this on. The data decides.

    The rules are min of mins, max of maxes, a mean weighted by SAMPLE COUNT,
    and a standard deviation pooled from the per-file count, mean and std.

    A file's byte size is not its number of samples, so the size never weighs
    a number here. A large file can hold few samples of one signal, and a
    small file can hold many.

    EVERY file row of the signal must carry a block. One measured file beside
    one unmeasured file describes part of the run, and a part served as the
    whole is a wrong number that looks like a right one. Such a signal answers
    None, and the row then lists with blank numbers.

    That rule decides a real answer, and it decides more since the run-signals
    list stopped asking the lake. It used to send the signal to the lake, which
    reads every sample. It now costs the row its numbers, so the reader sees a
    blank in place of a part served as the whole.

    One measured file needs no merge at all. Its own four numbers already
    describe the run, so they pass through and no count is needed.

    Two or more measured files need a count each. Without every count the
    merge refuses and answers None, and the row lists blank. The alternatives
    all state a number the data does not support: a plain average assumes
    equal counts, and any average of standard deviations is not a standard
    deviation of the union.

    The four optional quantities of FR-DM-014 split here, and they split on
    the mathematics, not on taste:

    * **RMS merges exactly**, from the per-file RMS and the sample counts. It
      is a mean of squares. See `_pooled_rms`.
    * **A percentile does not merge.** The median of two files is not the
      median of their union, and the six numbers of the two blocks hold no
      information that recovers it. A run of two or more measured files
      therefore carries NO percentile, and the three fields list blank. This
      module states no approximation, because an approximate median served
      as a median is the same wrong number this file refuses everywhere else.

    One measured file passes all four through, because its own numbers
    describe the whole run.
    """
    if not rows or any(not row.get("stats") for row in rows):
        return None
    measured = _ranked(rows)
    extremes = {
        "min": min(row["stats"]["min"] for row in measured),
        "max": max(row["stats"]["max"] for row in measured),
    }
    if len(measured) == 1:
        only = measured[0]["stats"]
        return {
            **extremes,
            "mean": only["mean"],
            "std": only["std"],
            **_stated(only, _OPTIONAL_STAT_FIELDS),
        }

    counts = [_sample_count(row) for row in measured]
    if None in counts:
        return None
    total = sum(counts)
    mean = sum(count * row["stats"]["mean"] for count, row in zip(counts, measured)) / total

    # The parallel-variance form (Chan, Golub and LeVeque). Each file gives its
    # own sum of squares, plus the shift of its mean from the merged mean:
    #     M2  = SUM (n_i - 1) * std_i^2  +  SUM n_i * (mean_i - mean)^2
    #     std = sqrt( M2 / (n - 1) ),  n = SUM n_i
    # The (n_i - 1) and (n - 1) divisors read std_i as a SAMPLE standard
    # deviation. That is what stddev(value) answers in the lake SQL below, and
    # what the pipeline stage measures, so both sides state the same quantity.
    # n >= 2 here, because two files hold one sample each at the least.
    squares = sum(
        (count - 1) * row["stats"]["std"] ** 2 + count * (row["stats"]["mean"] - mean) ** 2
        for count, row in zip(counts, measured)
    )
    merged = {**extremes, "mean": mean, "std": math.sqrt(squares / (total - 1))}
    # RMS merges from the per-file values and the counts. A percentile does
    # not merge at all, so no percentile joins this row.
    rms = _pooled_rms(counts, measured)
    if rms is not None:
        merged[_RMS_FIELD] = rms
    return merged


def _measured_stats(groups: dict[str, list[dict]]) -> dict[str, dict]:
    """Keep only the keys the registry measured in full.

    A key the registry did not measure is absent, never None, so the caller
    reads the absence as "nobody measured this" and lists the row blank.
    """
    found = {key: _merge_stats(rows) for key, rows in groups.items()}
    return {key: stats for key, stats in found.items() if stats}


# An object with a key. Null, missing and empty are not measured.
_BLOCK_PRESENT = {
    "$gt": [
        {
            "$size": {
                "$objectToArray": {
                    "$cond": [{"$eq": [{"$type": "$stats"}, "object"]}, "$stats", {}]
                }
            }
        },
        0,
    ]
}

# The count `_sample_count` takes: a number of one or more.
_COUNT_PRESENT = {
    "$and": [
        {"$in": [{"$type": f"$stats.{_COUNT_FIELD}"}, ["int", "long", "double", "decimal"]]},
        {"$gte": [f"$stats.{_COUNT_FIELD}", 1]},
    ]
}

# The two rules `_merge_stats` answers None on.
_MEASURED = {
    "$and": [
        {"$eq": ["$blocks", "$rows"]},
        {"$or": [{"$eq": ["$rows", 1]}, {"$eq": ["$counts", "$rows"]}]},
    ]
}


def _page_names(db: Database, run_id: str, pagination: Pagination) -> tuple[list[str], dict]:
    """The signal names of one page, and how many of the run carry numbers.

    Mongo groups the run's rows and answers two small things: the names this
    page shows, and the measured/total split the envelope states. The service
    then reads the file rows of THOSE names only.

    Reading the run instead cost one document per signal per file. A run of
    720 files and 1471 signals is about a million documents for a page of
    twenty, and the container was killed for it.
    """
    grouped = {
        "$group": {
            "_id": "$name",
            "rows": {"$sum": 1},
            "blocks": {"$sum": {"$cond": [_BLOCK_PRESENT, 1, 0]}},
            "counts": {"$sum": {"$cond": [_COUNT_PRESENT, 1, 0]}},
        }
    }
    split = {
        "$group": {
            "_id": None,
            "total": {"$sum": 1},
            "measured": {"$sum": {"$cond": [_MEASURED, 1, 0]}},
        }
    }
    start = (pagination.page - 1) * pagination.page_size
    facet = {
        "$facet": {
            "names": [
                {"$sort": {"_id": 1}},
                {"$skip": start},
                {"$limit": pagination.page_size},
            ],
            "split": [split],
        }
    }
    answer = next(
        iter(
            db["file_signals"].aggregate(
                [{"$match": {"run_id": run_id}}, grouped, facet], allowDiskUse=True
            )
        ),
        {},
    )
    counted = next(iter(answer.get("split") or []), {"total": 0, "measured": 0})
    return [row["_id"] for row in answer.get("names", [])], counted


def merge_run_signals(db: Database, run_id: str, pagination: Pagination) -> dict:
    """List one row per signal of the run, from the DATABASE (contract #7).

    Mongo serves this whole page: the signals, their metadata AND their
    numbers. The `mf4-stats` pipeline stage measures each signal as it passes,
    `tm-connector` posts the four numbers, and this service stores them on
    `file_signals`. THIS ROUTE NEVER ASKS THE LAKE, so it can never answer 503.
    QuixLake serves the query surfaces instead: Explore, and the statistics
    detail routes.

    A signal nobody measured lists with null numbers, and the envelope carries
    `stats_unavailable` to say why the numbers are blank.
    The total counts distinct signals, so the count always agrees with the rows.
    """
    names, counted = _page_names(db, run_id, pagination)
    rows = list(db["file_signals"].find({"run_id": run_id, "name": {"$in": names}}))
    by_name = _weigh_rows(db, rows, "name")

    measured = _measured_stats(by_name)
    # The log states the split, so a reader knows how much the pipeline
    # measured of this run.
    logger.info(
        "run signals stats: the registry measured %d of %d signals, page of %d",
        counted["measured"],
        counted["total"],
        len(names),
    )
    merged = [{**_inventory(by_name[name]), "stats": measured.get(name)} for name in names]
    page = pagination.envelope(merged, counted["total"])
    page["items"] = _with_winning_units(db, page["items"])
    page["stats_unavailable"] = _stats_unavailable(counted["measured"], counted["total"])
    return page


def _stats_unavailable(measured: int, total: int) -> dict | None:
    """Say why this page carries blank numbers, or answer None.

    A blank number needs a reason, or a reader reads it as a zero. This route
    reads the registry only, so a blank number has ONE cause: the ingestion
    pipeline measured no complete statistics for that signal. The reason
    states how much of the run it measured, and it never names a lake: the
    lake configuration cannot change one number on this page.

    A page whose every signal carries numbers gets None, and so does a run
    with no signal rows at all: neither page holds a blank number to explain.
    """
    if total == 0 or measured == total:
        return None
    if measured == 0:
        return {
            "reason": "not_measured",
            "detail": (
                f"No signal of this run carries measured statistics, so all "
                f"{total} rows show blank numbers. The ingestion pipeline "
                "measures the numbers and this service stores them. The signal "
                "names, units and rates come from the file registry and are "
                "complete."
            ),
        }
    return {
        "reason": "partly_measured",
        "detail": (
            f"The ingestion pipeline measured {measured} of the {total} signals "
            f"of this run. The other {total - measured} show blank numbers, "
            "because no file measured them, or only a part of the run did. The "
            "signal names, units and rates come from the file registry and are "
            "complete."
        ),
    }


def _with_winning_units(db: Database, rows: list[dict]) -> list[dict]:
    """Give every row the unit of the source that wins.

    A file_signals row always carries the unit of its own file header, so it is
    always ``embedded``. A person corrects a unit on the catalogue row, so the
    catalogue can hold a higher-ranked answer. This applies the catalogue answer
    here, and the front end needs no overlay of its own.

    The catalogue read runs on the page, so it never grows with the run.
    """
    if not rows:
        return rows
    catalogue = db["signals"].find(
        {"_id": {"$in": [row["name"] for row in rows]}}, {"unit": 1, "unit_source": 1}
    )
    by_name = {row["_id"]: row for row in catalogue}
    return [_winning_unit(row, by_name.get(row["name"])) for row in rows]


def _winning_unit(row: dict, catalogue: dict | None) -> dict:
    """Pick the unit of the higher-ranked source for one row.

    api.provenance owns the rank, so this function states no second rule. An
    equal rank keeps the file answer, because the file row describes this run.
    """
    if not catalogue:
        return row
    source = catalogue.get("unit_source")
    if source is None:
        return row
    if not blocks(source, Source(row["unit_source"])):
        return row
    return {**row, "unit": catalogue.get("unit"), "unit_source": source}


def _page(pagination: Pagination, rows: list[dict]) -> dict:
    start = (pagination.page - 1) * pagination.page_size
    return pagination.envelope(rows[start : start + pagination.page_size], len(rows))


def _weigh_rows(db: Database, rows: list[dict], key: str) -> dict[str, list[dict]]:
    """Weigh every row by its file and group the rows by one key."""
    weights = _file_weights(db, {row["file_id"] for row in rows})
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        row["weight"] = weights.get(row["file_id"], 1)
        grouped.setdefault(row[key], []).append(row)
    return grouped


def _lake_table() -> str:
    # No column map lives here on purpose. The SQL below reads `run_id`,
    # `signal` and `value` only, and every known physical table spells those
    # three the same. The per-table spellings of the other columns (`ts_ms`,
    # `file_name` on test_signal_samples_v3) moved to the frontend when the
    # guard (`explore_guard.py`) was deleted on 24 Aug 2026:
    # `frontend/lib/explore/lake-schema.ts` owns that map now.
    return os.environ.get("TM_LAKE_TABLE", "").strip() or _DEFAULT_LAKE_TABLE


def _aggregate_sql(group_by: str, where_column: str, value: str) -> str:
    """Build one DuckDB aggregate over the samples of the lake table.

    Both filters name a partition column, so the query never reads the whole
    table. QuixLake runs the SQL. This module builds no query engine.

    The lake reads every sample of the group, so it computes the eight
    quantities of FR-DM-014 in one pass. A percentile is exact here for the
    same reason it cannot merge in `_merge_stats`: this side holds the whole
    sample, and that side holds six numbers per file.
    """
    return (
        f"SELECT {group_by}, min(value) AS min, max(value) AS max, "
        "avg(value) AS mean, stddev(value) AS std, "
        "sqrt(avg(value * value)) AS rms, "
        "quantile_cont(value, 0.5) AS p50, quantile_cont(value, 0.95) AS p95, "
        "quantile_cont(value, 0.99) AS p99 "
        f"FROM {_lake_table()} "
        f"WHERE {where_column} = {lake.quote(value)} "
        f"GROUP BY {group_by}"
    )


def signal_stats_sql(name: str) -> str:
    """Build the aggregate that answers #16: one row per run of one signal."""
    return _aggregate_sql("run_id", "signal", name)


def run_stats_sql(run_id: str) -> str:
    """Build the aggregate for one row per signal of one run.

    The run-signals list (#7) reads the registry and never sends this. The
    Explore chat context sends it, because that context describes a run from
    the samples themselves.
    """
    return _aggregate_sql("signal", "run_id", run_id)


def _numbers(row: dict[str, str]) -> dict | None:
    """Read the statistics out of one CSV row.

    The four core quantities decide the row. A missing one means the lake
    could not compute the row. stddev answers NULL for a single sample, and
    NULL arrives as an empty CSV field.

    A NaN or an infinity is not a number the contract can carry. float() takes
    both, and the JSON writer then turns them into null on a field the contract
    declares as a number. Such a row counts as unmeasured instead.

    RMS and the three percentiles are read apart, and each one is optional.
    An older lake, or a lake table this query cannot compute a percentile over,
    leaves the field out of the row. That must cost the field alone, never the
    whole row, so this reads them one by one and drops what it cannot read.
    """
    try:
        numbers = {field: float(row[field]) for field in _STAT_FIELDS}
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(number) for number in numbers.values()):
        return None
    return {**numbers, **_stated(_floats(row), _OPTIONAL_STAT_FIELDS)}


def _floats(row: dict[str, str]) -> dict:
    """Read the optional columns of one CSV row as numbers, where they read.

    A CSV field is text. An empty field is a NULL from the lake, and a field
    the query did not select is absent. Both mean "no number here".
    """
    found = {}
    for field in _OPTIONAL_STAT_FIELDS:
        try:
            found[field] = float(row[field])
        except (KeyError, TypeError, ValueError):
            continue
    return found


def _keyed(rows: list[dict[str, str]], key: str) -> dict[str, dict | None]:
    return {row[key]: _numbers(row) for row in rows if row.get(key)}


def _lake_rows(sql: str) -> list[dict[str, str]]:
    """Run one aggregate on the lake, or answer 503 lake_unavailable.

    A dependency that is down is not a broken service, so this never becomes a
    500. The message names the variable that configures the lake and carries no
    exception text, no host and no token (contract A).
    """
    try:
        return lake.query(sql)
    except lake.LakeAuthError as error:
        # A refused token is not a lake that is down. The old message sent the
        # operator to hunt the host. It names the credential instead.
        logger.warning("QuixLake refused the statistics query: %s", error)
        # The detail names the token first, because the token is the fault. It
        # still names the URL: `test_a_failing_lake_answers_503_...` holds every
        # 503 to that name, and a wrong URL can point at a lake we may not read.
        detail = (
            "The statistics service refused this service's credential. Check "
            f"the value of {lake.TOKEN_VAR}, and check that {lake.URL_VAR} "
            "names the right lake."
        )
        raise ApiError(503, detail, "lake_unavailable") from error
    except lake.LakeError as error:
        logger.warning("QuixLake did not serve the statistics: %s", error)
        if lake.is_configured():
            detail = (
                "The statistics service did not answer. Check QuixLake and the "
                f"value of {lake.URL_VAR}."
            )
        else:
            detail = (
                "The statistics service is not configured. Set "
                f"{lake.URL_VAR} to the QuixLake address."
            )
        raise ApiError(503, detail, "lake_unavailable") from error


def _lake_stats_by_run(name: str) -> dict[str, dict | None]:
    """Ask QuixLake for one row of statistics per run of one signal (#16)."""
    return _keyed(_lake_rows(signal_stats_sql(name)), "run_id")


def _lake_stats_by_signal(run_id: str) -> dict[str, dict | None]:
    """Ask QuixLake for one row of statistics per signal of one run.

    The Explore chat context is the one caller. The run-signals list serves
    the registry numbers and asks nobody.
    """
    return _keyed(_lake_rows(run_stats_sql(run_id)), "signal")


def signal_run_stats(
    db: Database,
    name: str,
    pagination: Pagination,
    definition: str | None = None,
    rig: str | None = None,
    include_invalid: bool = False,
) -> dict:
    """Aggregate one signal over the runs that measured it (contract #16).

    The numbers come from whoever measured them: the registry for a run the
    pipeline measured, and QuixLake for every other run. Mongo supplies the
    run document, so the status, the definition, the rig and the date always
    come from the run. The default drops flagged runs. Newest run first.
    """
    by_run_rows = _weigh_rows(db, list(db["file_signals"].find({"name": name})), "run_id")
    measured = _measured_stats(by_run_rows)
    logger.info(
        "signal stats: the registry measured %d of %d runs",
        len(measured),
        len(by_run_rows),
    )
    # This list always asks the lake, unlike the per-run list above. The lake
    # can hold a run the registry has no file row for, and such a run belongs
    # in this list. #7 lists the signals of one known run, so it can skip.
    from_lake = _lake_stats_by_run(name)
    # A measured run wins its own row. Its numbers never blend with a lake row.
    by_run = {**from_lake, **measured}

    query: dict = {"_id": {"$in": list(by_run)}}
    if definition:
        query["definition_ids"] = definition
    if rig:
        query["rig_id"] = rig

    rows = []
    for run in db["test_runs"].find(query).sort("first_data_at", DESCENDING):
        status = derive_status(run)
        if status == "invalid" and not include_invalid:
            continue
        stats = by_run[run["_id"]]
        run_date = run.get("first_data_at") or run.get("started_at")
        if stats is None or run_date is None:
            continue
        rows.append(
            {
                "run_id": run["_id"],
                "definition_id": next(iter(run.get("definition_ids") or []), None),
                "rig_id": run.get("rig_id"),
                "run_date": run_date.date(),
                "status": status,
                **stats,
            }
        )
    return _page(pagination, rows)
