# dcm-seed-dbc

Seeds the Dynamic Configuration Manager with CAN databases as JSON documents, so
the ingestion path can decode against an **external, versioned** database rather
than only the one embedded in an MF4 file.

Runs as a Job: it seeds once and exits.

## Why this exists

DCM holds configuration too large for a Kafka message. The `config-updates` topic
carries only an event; consumers fetch the content through
`QuixConfigurationService`. DCM's default content store keeps the body inside the
Mongo document, and the topic outlives that store - the SDK rebuilds versions from
topic events with no liveness check, so a wiped store leaves consumers resolving
versions whose content is gone. Recovery therefore has to be reproducible from
git, which is what this Job is.

## What it writes

One configuration per `.dbc` in `dbc/`:

| field | value |
|---|---|
| `metadata.type` | `DCM_TYPE` (default `dbc`) |
| `metadata.target_key` | the `.dbc` basename, e.g. `ford_lincoln_base_pt` |
| `content` | `dbc_json.to_json(...)`, schema `can-database/1` |

DCM derives the configuration id as `sha1(f"{type}-{target_key}")`. That is the
same id `rlog-to-mf4` stamps into an MF4 header as `dcm.config_id` on `main`,
which is what lets a decoder resolve the right database for a file it has not
seen before.

`replace: true` means a re-run adds a version rather than failing, so the Job is
idempotent and versioning is visible in the Configurations UI.

## Stored as JSON, not as a blob

`dbc_json.py` is taken unchanged from `mf4-replay` on `main`, so a document written
here and a database rebuilt there come from identical code. As a structured document
the database is inspectable in the UI, addressable with JSONPath, and readable
through `json_field` without a decode round-trip - while `from_json` still rebuilds a
real cantools `Database`, keeping bit extraction in cantools.

## Running it again

Re-deploying the Job re-runs it. Change `DBC_NAMES` to seed a different subset;
every name must have a matching `dbc/<name>.dbc` bundled in this app.
