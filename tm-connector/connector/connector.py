"""The two lanes and the one ordering rule.

🔴 A file registered before its run exists is quarantined PERMANENTLY.
`register_file_document` reads `known_run` and, when the run is absent, writes
`status, reason = "quarantined", "no run key"`
(api/api/routers/files.py:436-446). The consequences are all verified:

* no signal inventory and no catalogue — `upsert_file_signals` sits inside
  `if status == "registered"` (files.py:506-507);
* no run rollup — `apply_file_rollup` returns for an unknown run
  (queries_runs.py:966-968);
* a replay does NOT repair it — `_existing_quarantined` matches on
  `storage_ref` and returns the same document with `created=False`
  (files.py:368-393, 430-434), and the unique (run, checksum) index is
  partial on `status: "registered"` (api/db.py:75-96), so the quarantined
  document never becomes the checksum owner either;
* the only exit is a human `PATCH /files/{file_id}` (files.py:131-245).

So `POST /test-runs` must succeed BEFORE `POST /files` is attempted, on every
path. That is enforced structurally: the file register lives in exactly ONE
function, the run upsert is the statement above it, and the only thing between
them is an early return.
"""

import logging
from datetime import UTC, datetime

from connector import bodies
from connector.bodies import Stamper
from connector.config import Config
from connector.identity import Identity, resolve_identity
from connector.inventory import FileInventory
from connector.registry import Registry, RegistryRejected

log = logging.getLogger("tm-connector")

# Above this many files awaiting their terminal marker, something upstream is
# wrong (a stopped decoder, a replay storm). Memory per file is tens of KB, so
# this warns rather than evicts: evicting would drop an inventory we cannot rebuild.
INFLIGHT_WARN_AT = 100


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Connector:
    """Consumes two topics, calls three routes, holds no bytes."""

    def __init__(self, registry: Registry, config: Config, clock=_utcnow) -> None:
        self._registry = registry
        self._config = config
        self._now = clock
        self._inflight: dict[str, FileInventory] = {}
        self._last_completed: dict | None = None
        self.runs_upserted = 0
        self.files_registered = 0
        self.files_replayed = 0
        self.journal_events = 0
        self.journal_failures = 0
        # A body the registry refused. Counted, never retried, never silent.
        self.poisoned = 0
        self.signals_seen_total = 0

    # --- lane 1: mf4_metadata ---------------------------------------------------

    def on_metadata(self, value: dict) -> None:
        """`POST /test-runs` only. Never `POST /files`.

        This is the immediate registration the demo needs: the run exists as
        soon as the upload lands, before any decode, and even if the decode
        never happens. It also cannot violate the ordering constraint, because
        it touches no file route at all.
        """
        if not isinstance(value, dict):
            return
        upload_id = str(value.get("id") or "")
        filename = str(value.get("filename") or "")
        # Import never opens the MF4, so the header channel is empty here. The
        # declared bag is the only identity available at this point.
        identity = resolve_identity(
            value.get("declared"), {}, filename, self._config.run_key_pattern
        )

        entry = self._inflight.get(upload_id)
        if entry is None:
            entry = FileInventory(upload_id=upload_id, first_seen_at=self._now())
            self._inflight[upload_id] = entry
        entry.metadata_seen = True
        entry.file_name = filename or entry.file_name
        entry.run_id = identity.run_id or entry.run_id
        uploaded_at = value.get("uploaded_at")
        entry.uploaded_at = uploaded_at if isinstance(uploaded_at, str) else None
        entry.touch(self._now())

        if len(self._inflight) >= INFLIGHT_WARN_AT:
            log.warning("%d files awaiting a terminal marker", len(self._inflight))

        if identity.run_id is None:
            # Nothing to register yet. The file still reaches the registry at
            # the terminal marker, with `run_id: null` and the deliberate
            # quarantine that names.
            log.info("no run key declared for %s; registration waits for the decode", filename)
            return

        try:
            self._registry.upsert_run(bodies.run_body(identity, self._config.actor, self._config.lake_table))
        except RegistryRejected as error:
            self._poison("POST /test-runs", error)
            return
        self.runs_upserted += 1

    # --- lane 2: mf4-to-msg -----------------------------------------------------

    def on_batch(self, value: dict) -> None:
        """Accumulate signal NAMES, then finalize on the terminal marker."""
        if not isinstance(value, dict):
            return
        kind = value.get("kind")
        if kind == "samples":
            self._observe(value)
        elif kind == "file_complete":
            self._finalize(value)
        # Any other kind is a producer we do not know. Ignoring it is safer than
        # guessing, and the sink filters the same way.

    def _observe(self, value: dict) -> None:
        upload_id = str(value.get("upload_id") or "")
        entry = self._inflight.get(upload_id)
        if entry is None:
            # Batches before their metadata message, or after a restart. Every
            # batch carries `file`, `declared` and `header_properties`, so this
            # lane is self-sufficient and out-of-order is ordinary, not an error.
            entry = FileInventory(upload_id=upload_id, first_seen_at=self._now())
            self._inflight[upload_id] = entry
        entry.file_name = entry.file_name or str(value.get("file_name") or "")
        # The status page is read by a person, so a partition sentinel must not
        # appear there as if it were a run.
        entry.run_id = entry.run_id or bodies.no_sentinel(value.get("run_id"))
        entry.observe_batch(value, self._now())

    def _finalize(self, value: dict) -> None:
        """The whole file path: run, then file, then the journal burst."""
        upload_id = str(value.get("upload_id") or "")
        # Read, don't pop: `upsert_run` and `register_file` can raise
        # RegistryUnavailable, and Kafka then redelivers this marker. An entry
        # popped before the calls succeed would make that redelivery register
        # the file with every tally at zero. The pop happens on the three
        # exits below — success and both poison paths — never before.
        entry = self._inflight.get(upload_id) or FileInventory(
            upload_id=upload_id, first_seen_at=self._now()
        )
        file_block = value.get("file") if isinstance(value.get("file"), dict) else {}
        batch_block = value.get("batch") if isinstance(value.get("batch"), dict) else {}
        filename = str(value.get("file_name") or entry.file_name or "")
        entry.file_name = filename

        # `bodies.file_body` folds the list into the inventory; the marker that
        # carries none still produces a body, from the batches we saw.
        if "inventory" not in batch_block:
            # Inferring the catalogue from the batches we happened to see is the
            # exact loss this field closes: a channel that emitted nothing is in
            # the file and missing from the registry. It stays as a degrade so no
            # signal is ever lost, but it is never quiet.
            log.error(
                "%s carried no signal inventory, so the catalogue is inferred from its "
                "batches and any channel that produced none is missing from it",
                filename or upload_id,
            )

        suppressed = batch_block.get("samples_suppressed")
        suppressed = suppressed if isinstance(suppressed, str) and suppressed else None
        if suppressed:
            # The decoder refused to write rows it could not place. The file and
            # its inventory are still real, so this narrates — it never becomes a
            # quarantine reason of our own.
            log.warning("%s produced no sample batches: %s", filename, suppressed)

        identity = resolve_identity(
            value.get("declared"),
            value.get("header_properties"),
            filename,
            self._config.run_key_pattern,
        )
        entry.run_id = identity.run_id

        # --- 🔴 ORDERING: the run first, and nothing between the two calls. ---
        if identity.run_id is not None:
            try:
                self._registry.upsert_run(bodies.run_body(identity, self._config.actor, self._config.lake_table))
            except RegistryRejected as error:
                # A malformed run body must NEVER fall through to POST /files:
                # the file would quarantine permanently on "no run key".
                self._poison("POST /test-runs", error)
                self._inflight.pop(upload_id, None)
                return
            self.runs_upserted += 1
        # A run id from neither channel and no filename match: register with
        # `run_id: null` and accept the permanent quarantine. That is the
        # registry's designed answer for an unlinkable file and the never-drop
        # choice (ingestion/watcher.py:422-423); the exit is a human PATCH.

        body = bodies.file_body(identity, entry, file_block, batch_block, filename)
        try:
            document, created = self._registry.register_file(body)
        except RegistryRejected as error:
            self._poison("POST /files", error)
            self._inflight.pop(upload_id, None)
            return

        self._inflight.pop(upload_id, None)

        if created:
            self.files_registered += 1
            self._narrate(document, entry, identity, file_block, batch_block, suppressed)
        else:
            # A same-run checksum replay: a redelivery, or the same bytes
            # re-sent to the run that already holds them. The file carries its
            # timeline from the first pass, and POST /journal has no dedup, so
            # narrating again would double the ingestion timeline. Identity is
            # (run, checksum) since 24 Aug 2026, so the same bytes declared
            # for a DIFFERENT run register fresh and never land here — the
            # cross-run "nothing was registered" warning this branch used to
            # carry has no remaining trigger.
            self.files_replayed += 1

        self.signals_seen_total += len(entry.signals)
        self._last_completed = {
            "upload_id": entry.upload_id,
            "run_id": identity.run_id,
            "file_id": document.get("file_id") or document.get("_id"),
            "file_name": filename,
            "status": document.get("status"),
            "quarantine_reason": document.get("quarantine_reason"),
            # What the registry now catalogues for this file, which is the
            # decoder's channel list — not only the channels that reached a batch.
            "signals": len(body["signals"]),
            "samples": entry.sample_count,
            "samples_suppressed": suppressed,
            "created": created,
            "at": self._now().isoformat().replace("+00:00", "Z"),
        }

    # --- the journal burst ------------------------------------------------------

    def _narrate(
        self,
        document: dict,
        entry: FileInventory,
        identity: Identity,
        file_block: dict,
        batch_block: dict,
        suppressed: str | None = None,
    ) -> None:
        """Write the timeline, after the file exists, in one burst.

        `POST /journal` 404s on an unknown `entity_id` for `entity_type:"file"`
        (api/api/routers/journal.py:79-80), so no event can be written earlier.
        Each event carries its own honest `at` — the moment the step happened —
        and the server stamps `received_at` beside it.
        """
        entity_id = document.get("file_id") or document.get("_id")
        if not entity_id:
            return
        actor = self._config.actor
        stamper = Stamper()
        terminal = self._now()
        detected_at = _parse_or(entry.uploaded_at, entry.first_seen_at)

        events = [
            bodies.journal_event(
                bodies.FILE_DETECTED,
                entity_id,
                f"{entry.file_name} arrived through mf4-to-blob.",
                stamper.at(detected_at),
                actor,
            )
        ]

        # What the checksum claim means, exactly: mf4-to-blob hashed the bytes
        # as it streamed them into blob storage; the decoder reads the object
        # back and takes no second digest, so a marker carrying none states
        # `unverified`. `verified` says those two digests agree — a digest was
        # computed over the stored bytes and it matches the digest taken on the
        # way in. There is no independently declared expected value
        # to compare against (the manifest is gone, and a file cannot contain its
        # own hash), so this claims storage integrity end to end and nothing more.
        # It is NOT a statement that the bytes are the bytes the bench intended.
        _, checksum_state, _ = bodies.checksum_facts(file_block)
        if checksum_state == "mismatch":
            events.append(
                bodies.journal_event(
                    bodies.CHECKSUM_FAILED,
                    entity_id,
                    "The stored object's digest does not match the digest taken at upload.",
                    stamper.at(terminal),
                    actor,
                )
            )
        elif checksum_state == "verified":
            events.append(
                bodies.journal_event(
                    bodies.CHECKSUM_VERIFIED,
                    entity_id,
                    "A digest was computed over the stored bytes and matches the upload digest.",
                    stamper.at(terminal),
                    actor,
                )
            )
        # An unverified file gets NEITHER event. The vocabulary is frozen at five
        # names, and claiming a digest matched when none was taken is worse than
        # a gap in the timeline the file's own state already explains.

        events.append(
            bodies.journal_event(
                bodies.HEADER_PARSED,
                entity_id,
                self._header_note(identity, suppressed),
                stamper.at(terminal),
                actor,
            )
        )

        # The marker STATES the decoder's counts since lane 2 became
        # markers-only (26 Aug 2026); the observed tally is 0 there, and
        # reading only it silently dropped this event from every ingestion
        # timeline — the one regression the chain test caught post-merge.
        # The observed tally still covers a producer that ships batches on
        # this lane (the pre-merge shape, and several test rigs).
        sample_count = batch_block.get("sample_count") or entry.sample_count
        signal_count = batch_block.get("signal_count") or len(entry.signals)
        if sample_count:
            events.append(
                bodies.journal_event(
                    bodies.SAMPLES_WRITTEN,
                    entity_id,
                    # "the decoder produced these", NOT "the lake committed
                    # them". The sink is a separate consumer on the same topic
                    # and this service cannot observe its writes.
                    f"The decoder produced {sample_count} samples across "
                    f"{signal_count} signals.",
                    stamper.at(terminal),
                    actor,
                )
            )
        decode_error = batch_block.get("decode_error")
        if decode_error:
            log.warning("%s decoded with an error: %s", entry.file_name, decode_error)

        for event in events:
            if self._registry.post_event(event):
                self.journal_events += 1
            else:
                self.journal_failures += 1

    def _header_note(self, identity: Identity, suppressed: str | None = None) -> str:
        """The header_parsed note, carrying any precedence conflict.

        The journal vocabulary is frozen at five names, so a disagreement — and
        the decoder's reason for writing no rows — are reported here rather than
        through an invented `file.identity_conflict`.
        """
        base = f"Resolved run {identity.run_id or '(none)'} on rig {identity.rig_id}."
        if identity.run_id_derived:
            base += " The run key came from the filename."
        if identity.conflicts:
            base += " " + "; ".join(identity.conflicts) + "."
        if suppressed:
            base += f" No sample batches were produced: {suppressed}."
        return base

    def _poison(self, route: str, error: RegistryRejected) -> None:
        self.poisoned += 1
        log.error(
            "%s refused our body with %s and re-sending it can never succeed: %s",
            route,
            error.status_code,
            error.detail,
        )

    # --- status -----------------------------------------------------------------

    def status_snapshot(self) -> dict:
        """What "stalled" and "healthy" look like without reading Kafka lag.

        This service's consumer lag tracks the decoder's bulk throughput, not its
        own work, so lag says nothing useful about whether it is progressing.
        """
        now = self._now()
        stall_after = self._config.stall_seconds
        in_flight = []
        stalled = 0
        # A copy, because this runs on the HTTP thread while the Kafka thread
        # mutates the dict; iterating the live view raises "dictionary changed
        # size during iteration". list() runs under the GIL in one step.
        for entry in list(self._inflight.values()):
            idle = (now - entry.last_activity_at).total_seconds()
            is_stalled = idle > stall_after
            stalled += int(is_stalled)
            in_flight.append(
                {
                    "upload_id": entry.upload_id,
                    "run_id": entry.run_id,
                    "file_name": entry.file_name,
                    "metadata_seen": entry.metadata_seen,
                    "batches_seen": entry.batches_seen,
                    "signals_seen": len(entry.signals),
                    "idle_seconds": round(idle, 1),
                    "stalled": is_stalled,
                }
            )
        return {
            "service": "tm-connector",
            "now": now.isoformat().replace("+00:00", "Z"),
            "files_in_flight": in_flight,
            "stalled_files": stalled,
            "last_completed": self._last_completed,
            "counters": {
                "runs_upserted": self.runs_upserted,
                "files_registered": self.files_registered,
                "files_replayed": self.files_replayed,
                "signals_seen": self.signals_seen_total,
                "journal_events": self.journal_events,
                "journal_failures": self.journal_failures,
                "poisoned": self.poisoned,
                "registry_retries": self._registry.retries_spent,
            },
        }


def _parse_or(value: str | None, fallback: datetime) -> datetime:
    if not value:
        return fallback
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return fallback
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
