# Superseded — see `dev-planning/upload-claims-platform/spec.md`

**Status:** Superseded, 2026-09-25

This spec was written twice on a wrong premise: that the user's *"rewrite workorder, rig id
and project on upload"* meant the Test Manager's `work_orders.project`.

It does not. The user's requirement is *"imagine you are uploading traces for Porsche Taycan
and Porsche Macan, cannot be stored under same project in lake"* — which is the lake's
**`platform`** partition and the DCM `target_key` that picks the CAN database. That is a
different field, already a Hive partition column, and simply unfed.

**The live spec is `dev-planning/upload-claims-platform/spec.md`.**

Two findings from these rounds survive and are carried into it:

- `work_orders.project` is not authorable from an upload — a run only ever inherits it
  (`api/api/services/queries_runs.py:140-143`, `:1187-1190`, `planning_sync.py:572`). The
  new spec leaves it alone entirely; `upload-claims-platform/spec.md` §9 shows the two
  fields never compete, because the sink consults the work order's `project` only when the
  batch's `platform` is `unknown` (`mf4-datalake-sink/expand.py:171-173`).
- `create_work_order` (`api/api/services/queries_runs.py:1852-1913`) never closes the
  claims a run is already holding, because `BL-72` deleted the sync pass that used to call
  `planning_sync._link_retained_claims`. That is a real, separate regression, being fixed
  in parallel from `api/tests/test_work_order_closes_claims.py`, and is noted as deferred in
  `upload-claims-platform/spec.md` §11.
