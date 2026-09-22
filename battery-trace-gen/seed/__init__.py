"""Seed the Test Manager from the battery set: one work order, ten definitions.

`generate.py` writes the evidence; this package writes the plan the evidence
answers to. It reads the same four documents CLAUDE.md names as the statement of
record — the requirements, the parameters, the test specs and the generated
verdict manifest — and turns them into:

* the `POST /planning/sync` body: 1 work order, 10 test definitions with one
  rendered requirements markdown each, and the 10 run->definition links;
* the 10 executable test implementations, one `.py` per definition, uploaded to
  `POST /test-definitions/{td_id}/implementation`.

Run it with `python -m seed` from `battery-trace-gen/`.
"""
