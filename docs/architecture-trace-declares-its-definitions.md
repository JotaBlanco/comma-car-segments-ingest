# A trace states the test definitions it answers — build notes

The design record is `dev-planning/trace-declares-its-definitions/spec.md`. This file
holds only what the build settled differently or found untrue in the spec. Read the spec
first; read this before trusting §6.4 or §6.5.

## What shipped

One derivation, two consumers. `manifest.definitions_of(scenario, tc_ids)` returns the
test case ids a scenario's `evaluates` set resolves to, in that set's order.
`manifest.build` fills `manifest.json`'s per-trace `definitions` from it, and
`generate.py` puts the same list into the `test` block it hands `mf4.write`, where the
already-shipped `_test_props` guard turns it into one HD-comment entry.

```
scenarios/T*.json  evaluates[].req_id
        |
        |  specs/battery-dc-test-specs.json  covers_req_ids, inverted
        v
manifest.test_case_ids()  {req_id: tc_id}
        |
        +--> manifest.definitions_of(scenario, tc_ids) -> ["BAT-SYS-TC-001", ...]
                     |                                |
                     |                                +--> manifest.json traces[].definitions
                     v
             generate.py  test={..., "definitions": [...]}
                     v
             bus/mf4.py _test_props
             <e name="test.definitions">BAT-SYS-TC-001,BAT-SYS-TC-002,BAT-SYS-TC-003</e>
                     v
    mf4-decoder provenance.py (forwards <common_properties> verbatim, zero new lines)
                     v
    tm-connector identity.py HEADER_LIST_FIELDS -> definition_ids
                     v
    api queries_runs._resolve_claims -> test_runs.definition_ids at Source.EMBEDDED
```

Hops 2 through 5 were untouched: no route, no model, no migration, no lake column.

## Why the generator and not the registry

Unchanged from spec D1, and confirmed by the build: `runner.py:50` builds the frame
scheduler from `dbc.messages`, so all four traces emit all 8 frames and all 249 signals.
Nothing in the lake discriminates one trace's coverage from another's, so a registry-side
derivation would attach all ten definitions to all four runs — and it would be a second
statement of coverage besides the authored `covers_req_ids` (board defect D1).

## Determinism

Established by reading the path, not by running the generator (Tester's job):

1. `scenario.expectations` is `[Expectation(**entry) for entry in document["evaluates"]]`
   (`scenario.py:184`) — a JSON array, so its order is the file's order.
2. `definitions_of` is a list comprehension over that list and only *looks up* in
   `tc_ids`; it never iterates a dict or a set, so no hash order reaches the output.
3. `_test_props` (`bus/mf4.py:88-109`) inserts `test.definitions` at a fixed position
   between `test.description` and `test.started_at`, and `_header_xml` emits
   `props.items()` in insertion order.
4. `mdf.header.start_time = start_time` (`bus/mf4.py:187`) still pins `##FH`.

The new bytes are therefore a pure function of files on disk. Two runs stay
sha256-identical; the four sha256s all move once, because the HD comment grew.

## File inventory

| File | Change |
|---|---|
| `battery-trace-gen/manifest.py` | `definitions_of()` lifted beside `test_case_ids()`; `build` calls it; `Scenario` imported |
| `battery-trace-gen/generate.py` | `tc_ids` read once before the loop; the `test` block carries `definitions` |
| `battery-trace-gen/bus/mf4.py` | comment only |
| `battery-trace-gen/scenario.py` | comment only |
| `battery-trace-gen/seed/sources.py`, `seed/planning_payload.py`, `seed/__main__.py` | comments only |
| `battery-trace-gen/README.md` | the paragraph claiming a trace names no definition |
| `battery-trace-gen/tools/gen_claude_md.py` | two template clauses — see correction 1 |
| `mf4-to-blob/static/index.html` | the claim-editor comment |
| `frontend/components/screens/run-detail/definitions-panel.tsx` | the manual-tag warning |

## Deviations and corrections

1. **Spec §6.5 is wrong that CLAUDE.md's ingestion prose is hand-written.** It is inside
   `gen_claude_md.py`'s `doc = f"""..."""` template (`:103-121`), as is the Seeding
   section's hierarchy paragraph (`:125-130`). Both said a trace claims no definitions;
   both were rewritten there, and **CLAUDE.md must be regenerated** —
   `python battery-trace-gen/tools/gen_claude_md.py`. Editing CLAUDE.md by hand would be
   erased by the next regeneration.
2. **No test pins the panel string.** Spec §6.4 assumed one. `frontend/tests/` and
   `frontend/e2e/` were searched for the sentence and for "manual"/"planning sync" near
   the panel: `definition-run.test.tsx` renders `DefinitionsPanel` ten times and asserts
   nothing about its copy. The string moved alone.
3. **An eighth false comment the spec's table missed:** `battery-trace-gen/README.md`
   §"Seeding the Test Manager" said "A trace claims no test definition". Rewritten.
4. **Stale elsewhere, left alone:** `dev-planning/tm-multi-definition-runs/architecture.md:112`
   notes "(no test.definitions: _test_props writes the key only for a scenario ...)".
   That file is the historical record of a different build; this spec supersedes it.

## The limitation this build did not fix

A claimed set where *some* ids are unknown is never repaired by a later planning sync:
`queries_runs._retained_claims` remembers one unknown id per field (`first.setdefault`),
and `planning_sync._link_retained_claims`' selector fires only when `definition_ids` is
empty or null — a partial set leaves the field non-empty. Unreachable here because
`python -m seed catalog` mirrors all ten definitions before any trace is uploaded
(`seed/__main__.py`). Recorded in `dev-planning/backlog.json` BL-80 as well as here; if
the seed order ever changes, this is the gap.

## Neighbouring features

- BL-81 (`dev-planning/upload-opens-its-work-order/spec.md`) does the same thing for the
  work-order claim, inside the registry rather than the generator — a work order must be
  *created*, a definition only *resolved*.
- BL-11 consumes `test_runs.definition_ids`: this feature fills its input and decides no
  verdict.
- BL-47's field-wide `manual` tag is why the panel warning had to change: an edit here
  outranks `embedded`, so a re-upload of the same trace writes nothing and journals
  nothing (`provenance.set_field` returns `None`).
