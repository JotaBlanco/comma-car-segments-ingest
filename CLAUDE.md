# comma-car-segments-ingest — project directives

Complements the global golden rules; does not restate them.

## Battery requirements & trace workflow (ASPICE)

A recurring exercise in this repo. The user supplies raw requirements; we take
them through the V-model chain to an evaluated run with a known pass/fail split.
The frame is **Automotive SPICE (ASPICE)**; EARS is only the sentence syntax used
to satisfy the "unambiguous and verifiable" attribute inside it.

### ASPICE process areas this chain implements
```
SYS.1 elicitation   -> requirement.source
SYS.2 sys req analysis -> requirement (the artifact below)
SYS.5 qualification test -> test-case -> test-impl -> trace -> result -> report
```
Every link has a schema in `backend-api/schemas/`. Nothing enters the chain that
does not validate against its schema.

### SYS.2 attributes → schema fields
ASPICE expects each system requirement to carry an identifier, a status,
verification criteria and bidirectional traceability. The canonical schema
(`backend-api/schemas/requirement-1.0.0.schema.json`) already supplies all of it:

| ASPICE expectation | Field |
|---|---|
| Unique identifier | `id` |
| Structured, unambiguous statement | `text` + `ears_pattern` |
| Verification criteria | `verification_method`, `measurand` |
| Measurable acceptance | `measurand` `{name, unit}` |
| Status through review | `status` (Draft/Reviewed/Approved/Rejected/Obsolete) |
| Traceability **up** to stakeholder need | `source` |
| Traceability **down** to tests | `verified_by` -> `ACC-SYS-TC-NNN` |
| Traceability **back** from tests | test-spec `covers_req_ids` |
| Consistency / impact analysis | `related_reqs` |
| Justification | `rationale` |

**Bidirectional traceability is the ASPICE bit that actually gets audited.**
`verified_by` and `covers_req_ids` must agree in both directions — a requirement
naming a test case the test case does not claim back is a finding, not a typo.

### Step 1 — rewrite into EARS "shall" form
`ears_pattern` is a closed enum:

| Pattern | Template |
|---|---|
| `Ubiquitous` | The \<system\> shall \<response\>. |
| `StateDriven` | While \<state\>, the \<system\> shall \<response\>. |
| `EventDriven` | When \<trigger\>, the \<system\> shall \<response\>. |
| `OptionalFeature` | Where \<feature\>, the \<system\> shall \<response\>. |
| `UnwantedBehaviour` | If \<trigger\>, then the \<system\> shall \<response\>. |
| `Complex` | Combination of the above. |

House style, copied from the 37-requirement ACC set: decimal **comma** in
thresholds (`3,5 m/s^2`), every timing bound explicit (`within 200 ms of that
detection`), never "promptly". One `shall` per requirement.

Schema rules that bite:
- `StateDriven` and `Complex` require a non-empty `system_states`.
- `verification_method: Test` requires a non-empty `measurand` — this is where
  the user's **parametrization** lands.
- `revision` matches `^[0-9]+\.[0-9]+$`; `figure_refs` match `^F[1-6]$`.

### Step 2 — design the battery model's signals, together
Signal design is a **joint** step with the user, not a solo dispatch. One row per
signal in `scripts/seed/signal-catalog.json` (`signal-catalog-1.0.0.schema.json`):
`signal`, `channel_group`, `table`, `unit`, `dtype`, `column_type`, `raster_hz`,
`role`, `source_spec`.

`role` separates input from output: `stimulus` drives the model, `response` is what
the requirement is evaluated against, `diagnostic` is observability only. Every
`measurand` name must resolve to a catalogued `response` signal or the evaluator
has nothing to measure.

### Step 3 — traces that cover the requirements
One test case per requirement (`tc_id`, `covers_req_ids`), shaped like
`scripts/seed/test-specs.json`. Traces are MF4 files carrying the catalogued
channel groups at their declared rasters.

### Step 4 — seed a deliberate 4-of-10 failure split
**6 pass, 4 fail** unless the user says otherwise. Failures must come from trace
content that genuinely violates the stated limit — never from a missing channel, a
broken signal or a schema error. A failure indistinguishable from a bug is a bad
failure. State which 4 were rigged, and how, in the hand-back.

### Open decisions — resolve with the user before building
- **ID namespace.** The schema hard-codes `^ACC-SYS-(FUN|PRF|SAF)-[0-9]{3}$`, and
  `chapter` / `system_states` are ACC-only enums (`Active-Cruise`,
  `Driver-Override`, ...). Battery requirements do not validate against it as
  written. Extend the schema, add a battery sibling, or map onto the ACC enums —
  ask, do not pick silently.
- The plant producing battery MF4s is not the ACC `acc_stim` tool; confirm what
  generates the traces before writing a generator.

## Environment notes
- Requirements are stored in **blob**, not Mongo — `GET /requirements` returns 503
  `blob_storage_unavailable` whenever `blobStorage.bind` is off.
- **Auto-injected variables do not belong in `quix.yaml`.**
  `Quix__BlobStorage__Connection__Json` and the four `Quix__Lakehouse__*` vars are
  injected by the platform when `blobStorage: bind: true`. Declaring them
  explicitly is what produced the "should have a secret key defined" sync error.
- Secret-typed variables bind with `variableKey: <project-variable>` (see
  `grafana_password`). The `quix cloud secrets` CLI/API is **deprecated** — it
  returns 204 and writes nothing; use `/repositories/{id}/project-variables`.
