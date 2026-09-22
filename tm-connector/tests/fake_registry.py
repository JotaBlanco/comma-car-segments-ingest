"""A fake Test Manager API that behaves like the mirrored one.

Every body is validated with the REAL pydantic models from
`api/api/models/*`, so `extra="forbid"`, the `Actor` check and the closed
`SourceSystem` enum all answer 422 here exactly as they do in production. The
rules below are transcriptions, each with the line it came from:

* quarantine order and the `known_run` gate — routers/files.py:436-446
* checksum replay, storage_ref replay — routers/files.py:363-393, 430-434
* the inventory only on a registered CREATE — routers/files.py:506-507
* 201 create / 200 merge on runs — routers/test_runs.py:183-197
* claims resolve against the planning mirror, else are remembered and the run
  stays amber — services/queries_runs.py:84-107, 143-155
* POST /journal 404s on an unknown file, and has NO dedup —
  routers/journal.py:63-97
"""

import json
import uuid

import httpx
from pydantic import ValidationError

from api.models.files import FileRegisterRequest
from api.models.journal import JournalEventRequest
from api.models.runs import RunUpsertRequest

PREFIX = "/api/v1"


class FakeApi:
    """State, fault injection and a call log."""

    def __init__(self, work_orders=("WO-2026-0853",), definitions=("TD-RLD-301",)):
        self.work_orders = set(work_orders)
        self.definitions = set(definitions)
        self.runs: dict[str, dict] = {}
        self.files: dict[str, dict] = {}
        self.journal: list[dict] = []
        # (path, body) in call order — the ordering tests read this directly.
        self.calls: list[tuple[str, dict]] = []
        # path -> permanent status code
        self.force_status: dict[str, int] = {}
        # path -> how many of the next calls answer 503
        self.transient: dict[str, int] = {}
        # path -> how many of the next calls raise a transport error
        self.disconnect: dict[str, int] = {}

    # --- plumbing ---------------------------------------------------------------

    def client(self, base_url: str) -> httpx.Client:
        return httpx.Client(
            base_url=base_url,
            headers={"Authorization": "Bearer t0ken"},
            transport=httpx.MockTransport(self._handle),
        )

    def paths(self) -> list[str]:
        return [path for path, _ in self.calls]

    def bodies(self, path: str) -> list[dict]:
        return [body for called, body in self.calls if called == path]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith(PREFIX):
            path = path[len(PREFIX) :]
        body = json.loads(request.content or b"{}")
        self.calls.append((path, body))

        if self.disconnect.get(path, 0) > 0:
            self.disconnect[path] -= 1
            raise httpx.ConnectError("registry unreachable", request=request)
        if self.transient.get(path, 0) > 0:
            self.transient[path] -= 1
            return self._json(503, {"detail": "service unavailable"})
        if path in self.force_status:
            return self._json(self.force_status[path], {"detail": "forced"})

        if path == "/test-runs":
            return self._upsert_run(body)
        if path == "/files":
            return self._register_file(body)
        if path == "/journal":
            return self._add_event(body)
        return self._json(404, {"detail": f"no route {path}"})

    @staticmethod
    def _json(code: int, payload: dict) -> httpx.Response:
        return httpx.Response(code, json=payload)

    # --- routes -----------------------------------------------------------------

    def _upsert_run(self, body: dict) -> httpx.Response:
        try:
            parsed = RunUpsertRequest.model_validate(body)
        except ValidationError as error:
            return self._json(422, {"detail": error.errors(include_url=False)})

        created = parsed.run_id not in self.runs
        doc = self.runs.setdefault(
            parsed.run_id,
            {
                "run_id": parsed.run_id,
                "rig_id": parsed.rig_id,
                "work_order_id": None,
                "definition_id": None,
                "claimed_work_order_id": None,
                "claimed_definition_id": None,
            },
        )
        # mode="json" so a stored document is exactly what a reader would see:
        # a datetime never leaks into the response body.
        stored = parsed.model_dump(mode="json")
        for name in (
            "description",
            "test_cell",
            "operator",
            "bench_sw",
            "started_at",
            "ended_at",
        ):
            if stored.get(name) is not None:
                doc[name] = stored[name]

        # A claim links only when the planning mirror holds the row. An unknown
        # id links nothing, is REMEMBERED, and the run stays amber.
        for field, mirror in (
            ("work_order_id", self.work_orders),
            ("definition_id", self.definitions),
        ):
            claimed = getattr(parsed, field)
            if claimed is None:
                continue
            if claimed in mirror:
                doc[field] = claimed
            else:
                doc[f"claimed_{field}"] = claimed

        doc["status"] = "complete" if doc["work_order_id"] else "awaiting_work_order"
        return self._json(201 if created else 200, doc)

    def _register_file(self, body: dict) -> httpx.Response:
        try:
            parsed = FileRegisterRequest.model_validate(body)
        except ValidationError as error:
            return self._json(422, {"detail": error.errors(include_url=False)})

        replay = self._existing_registered(
            parsed.checksum_sha256, parsed.run_id
        ) or self._existing_quarantined(parsed.storage_ref, parsed.checksum_sha256)
        if replay is not None:
            return self._json(200, replay)

        known_run = parsed.run_id is not None and parsed.run_id in self.runs
        if parsed.checksum_state == "mismatch":
            status, reason = "quarantined", "checksum mismatch"
        elif not known_run:
            status, reason = "quarantined", "no run key"
        elif parsed.quarantine_reason is not None:
            status, reason = "quarantined", parsed.quarantine_reason
        else:
            status, reason = "registered", None

        doc = {
            "file_id": f"f-{uuid.uuid4()}",
            "filename": parsed.filename,
            "run_id": parsed.run_id,
            "source_system": parsed.source_system,
            "format": parsed.format,
            "size_bytes": parsed.size_bytes,
            "checksum_sha256": parsed.checksum_sha256,
            "checksum_state": parsed.checksum_state,
            "status": status,
            "quarantine_reason": reason,
            "storage_ref": parsed.storage_ref,
            "signal_count": len({signal.name for signal in parsed.signals}),
        }
        self.files[doc["file_id"]] = doc
        # The inventory reaches the registry only on a registered CREATE.
        doc["_signals"] = (
            [signal.model_dump() for signal in parsed.signals] if status == "registered" else []
        )
        return self._json(201, doc)

    def _existing_registered(self, checksum: str, run_id: str | None) -> dict | None:
        # (run, checksum) identity, mirroring api/api/routers/files.py.
        for doc in self.files.values():
            if (
                doc["checksum_sha256"] == checksum
                and doc["status"] == "registered"
                and doc["run_id"] == run_id
            ):
                return doc
        return None

    def _existing_quarantined(self, storage_ref: str | None, checksum: str) -> dict | None:
        if not storage_ref:
            return None
        for doc in self.files.values():
            if (
                doc["storage_ref"] == storage_ref
                and doc["status"] == "quarantined"
                and doc["checksum_sha256"] in ("", checksum)
            ):
                return doc
        return None

    def _add_event(self, body: dict) -> httpx.Response:
        try:
            parsed = JournalEventRequest.model_validate(body)
        except ValidationError as error:
            return self._json(422, {"detail": error.errors(include_url=False)})
        if parsed.entity_type == "file" and parsed.entity_id not in self.files:
            return self._json(404, {"detail": f"File {parsed.entity_id} not found"})
        entry = parsed.model_dump()
        entry["id"] = f"j-{uuid.uuid4()}"
        self.journal.append(entry)
        return self._json(201, parsed.model_dump(mode="json") | {"id": entry["id"]})

    # --- reads for assertions ----------------------------------------------------

    def events_for(self, file_id: str) -> list[dict]:
        return [entry for entry in self.journal if entry["entity_id"] == file_id]

    def only_file(self) -> dict:
        assert len(self.files) == 1, f"expected one file, found {len(self.files)}"
        return next(iter(self.files.values()))
