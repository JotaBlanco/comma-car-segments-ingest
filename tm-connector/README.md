# tm-connector

Kafka to Test Manager registry. It is the only app that knows the Test
Manager exists and the only one holding its token; the decoder and the sink
keep writing to the lake whether it is running or not.

```
mf4_metadata ──┐
               ├──> tm-connector ──HTTP──> Test Manager API
mf4-to-msg  ───┘        (no blob access)
```

## What it does

Two independent lanes, no shared state:

| Lane | Trigger | Calls |
|---|---|---|
| `mf4_metadata` | one message per stored upload | `POST /test-runs` **only** |
| `mf4-to-msg` | `kind:"samples"` → accumulate names; `kind:"file_complete"` → finalize | `POST /test-runs`, then `POST /files`, then `POST /journal` ×N |

Every batch repeats its own `file`, `declared` and `header_properties` blocks, so
the second lane is self-sufficient: batches arriving before their metadata, or
after a restart, are ordinary.

## The three things a reviewer should check first

1. **The run exists before the file is registered.** A file registered against an
   unknown run is quarantined *permanently* (`api/api/routers/files.py:436-446`)
   — no inventory, no rollup, no repair by replay, only a human `PATCH`. The two
   calls live in one function with a hard early return between them
   (`connector/connector.py`), and `tests/test_ordering.py` proves a failed run
   upsert leaves no file document and does not commit.
2. **No sample array is ever retained.** One capture is 261 signals and ~602,000
   samples; the accumulator keeps five scalars per signal
   (`connector/inventory.py`), pinned by `tests/test_inventory.py`.
3. **No blob credentials.** No `blobStorage` bind, no `quixportal` dependency, no
   storage client anywhere — `tests/test_no_blob_access.py`.

## Status endpoint

Consumer lag here tracks the *decoder's* bulk throughput, not this service's own
work, so lag cannot answer "is it progressing". `GET /status` can: files in
flight (with `stalled` once `TM_STALL_SECONDS` passes with no batch), the last
completed file, signals seen, and the counters — including `poisoned`, the bodies
the registry refused. `GET /health` is the liveness probe.

## Tests

```
python -m pytest tm-connector/tests -q
```

The fake registry validates every body with the **real** mirrored pydantic models
from `api/api/models/`, so `extra="forbid"`, the `Actor` check and the closed
`SourceSystem` enum answer 422 in the tests exactly as they would in production.
