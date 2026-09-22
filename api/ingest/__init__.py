# Blob access for the Test Manager, plus the demo seed bytes.
#
# **This package stopped being the watcher on 19 Aug 2026.** The file watcher,
# the MF4 parse and the checksum helper moved to the ingestion pipeline. The
# pipeline owns every measurement file: it polls the landing prefix, parses the
# bytes, writes the samples to the lakehouse and registers the file through the
# public API. The Test Manager never opens a measurement file.
# See plans/design/INGEST-SPLIT.md.
#
# What stays here, and who needs it:
#   store.py     — the blob client for the two byte legs. The download route
#                  reads it (`api/api/services/file_bytes.py`) and the result
#                  upload writes through it (`api/api/services/file_writes.py`).
#   lake.py      — the QuixLake sample writer. `POST /test-runs/{run_id}/signals`
#                  reaches it by deferred import.
#   fixtures.py  — the MF4 byte mint. `blob_seed.py` needs it for the demo cast.
#   blob_seed.py — it fills each registered file's `storage_ref` with real
#                  bytes, so the download button serves something.
#
# The API imports nothing from here at module level. Both routes defer the
# import, so the API starts and serves every registry route without asammdf,
# numpy or quixportal on the path.
#
# The environment names:
#   Quix__BlobStorage__Connection__Json  the SAG connection (quixportal reads it)
#   Quix__Lakehouse__Query__Url          the QuixLake API, injected by the platform
#   Quix__Sdk__Token                     the lake bearer token
#   TM_INGEST_SOURCE=local               read a directory instead, for a
#   TM_LANDING_ZONE=<a directory>        developer without cluster access
#
# asammdf spike (2026-08-17): PASSED with asammdf 8.8.23 on Python 3.13.
# The exact version is pinned in uv.lock. `fixtures.py` still needs it, so the
# `ingest` dependency group keeps asammdf and numpy.
