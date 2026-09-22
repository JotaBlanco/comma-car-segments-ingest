# commaCarSegments ingest

An MF4 ingestion pipeline with a Test Manager registry over it. A recording is
uploaded, decoded against a versioned CAN database, written to one lake table
partitioned by the Test Manager's traceability chain, and registered — the run,
the file, its signal catalogue and its timeline — in the registry.

```
browser ──▶ mf4-to-blob ──▶ mf4-decoder ──▶ mf4-datalake-sink ──▶ LAKE_TABLE
                  │               │
                  └───────────────┴──▶ tm-connector ──▶ Test Manager API ──▶ frontend
```

| Directory | What it is |
|---|---|
| `mf4-to-blob/` | The upload page and its routes. Streams bytes to blob storage, produces `mf4_metadata`. |
| `mf4-decoder/` | Downloads, decodes against the DBC from Dynamic Configuration, produces sample batches and one `file_complete` marker per file. |
| `mf4-datalake-sink/` | Expands the batches to one Iceberg row per sample. |
| `dcm-seed-dbc/` | Seeds the CAN databases into Dynamic Configuration. A Job. |
| `tm-connector/` | The only app that talks to the Test Manager. Registers runs, files and journals. |
| `api/` | The Test Manager registry API, and the planning mock that stands in for a planning system. |
| `frontend/` | The Test Manager UI: work orders, definitions, runs, files, signals, Explore. |
| `mongo-explorer/` | Mongoku over the one MongoDB. Stopped by default. |
| `quixlab/`, `quixlakehouse-grafana/` | Notebooks and dashboards over the lake. |

**Read [`docs/test-manager-integration.md`](docs/test-manager-integration.md) first.**
It is the map: the message flow, the run-key ladder both the decoder and the
connector climb, the partition tree, the project variables, and how to run the
whole chain locally.

## Tests

Three separate invocations — `tests/` and `tm-connector/tests/` are both packages
named `tests`, so naming them in one command collides.

```sh
pytest -q                      # the pipeline's contract and law tests
pytest tm-connector/tests -q   # the connector's own suite
cd api && pytest tests -q      # the registry's own suite (starts a mongo:7 container)
cd frontend && npm run test:all   # the front end's (needs Node >= 22)
```
