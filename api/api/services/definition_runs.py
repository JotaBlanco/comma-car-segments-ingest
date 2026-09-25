"""What a definition run hands its Job, and the verdict it writes back.

The Job executes `file_writes.definition_notebook_key(td_id)`. Test Manager seeds the
default wrapper (`api/resources/verdict_notebook.py`) there once, so an engineer may
customise it in QuixLab and the next run executes their version. The wrapper loads
the definition's implementation from blob, calls its entry point, and returns
`{tc_id, run_id, verdict, evidence, evaluated_at}` as the run's outputs.

Starting a run also copies that implementation into the run's own blob folder and
registers it as a file of the run (`place_implementation`), so the Files tab lists
the module that judged the run beside the recording it judged.

The verdict lands through `results._store_result`, the shipped `POST /results` path, in
the shape `dev-planning/run-a-definition/spec.md` §5.1 pins.
"""

import logging
from collections.abc import Mapping
from datetime import UTC, datetime
from importlib import resources
from typing import Any

from pymongo.database import Database

from api.models.files import FileRegisterRequest
from api.models.results import ResultCreateRequest
from api.quix_identity import Identity
from api.quixlab_run import RunResult
from api.routers.files import register_file_document
from api.routers.results import COLLECTION, _store_result
from api.services import queries_stats
from api.services.file_bytes import FileBytesProvider, FileBytesUnavailable, blob_key
from api.services.file_writes import FileBytesWriter, implementation_blob_key

logger = logging.getLogger(__name__)

NOTEBOOK_RESOURCE = "verdict_notebook.py"
OUTCOMES = frozenset({"pass", "fail", "error"})
PRODUCED_BY = "verdict-runner"
DEFAULT_ENTRYPOINT = "evaluate"


def result_key(td_id: str) -> str:
    """The `result_key` every verdict of one definition carries."""
    return f"verdict/{td_id}"


def default_notebook() -> bytes:
    """The wrapper notebook shipped in the image."""
    return resources.files("api.resources").joinpath(NOTEBOOK_RESOURCE).read_bytes()


def ensure_notebook(provider: FileBytesProvider, writer: FileBytesWriter, key: str) -> None:
    """Seed the default notebook at `key` unless one is there. Never overwrites.

    Raises `FileBytesUnavailable` when the store takes no write.
    """
    try:
        stream, size = provider.open(f"blob://{key}")
    except FileBytesUnavailable as error:
        if error.reason != "blob_missing":
            raise
    else:
        close = getattr(stream, "close", None)
        if callable(close):
            close()
        logger.info("definition notebook %s already present (%s bytes); kept", key, size)
        return
    writer.check_ready()
    written = writer.write(key, iter([default_notebook()]))
    logger.info("definition notebook %s seeded with the default wrapper (%s bytes)", key, written)


def place_implementation(
    db: Database,
    provider: FileBytesProvider,
    writer: FileBytesWriter,
    *,
    run: Mapping[str, Any],
    definition: Mapping[str, Any],
    actor: str,
) -> dict:
    """Copy the definition's implementation into the run's folder and register it.

    The upload route files a definition's module under `UNASSIGNED_RUN`, because
    a definition is not a run. This is the one moment exactly one (run,
    definition) pair exists, so this is where the bytes that judge a run land
    beside the trace it recorded, as a file of that run with `role: evaluator`.

    The key carries the content digest, so a re-run after an edit writes a
    second object and the bytes a stored verdict cites survive. Re-running
    unchanged bytes overwrites the same object with itself and replays on
    (run, checksum), so no second file document is created.

    Raises `FileBytesUnavailable` when the store refuses either half.
    """
    implementation = definition["implementation"]
    filename = implementation["filename"]
    key = implementation_blob_key(run["_id"], filename, implementation["sha256"])
    chunks, size = provider.open(implementation["blob_path"])
    writer.write(key, chunks)
    doc, created = register_file_document(
        db,
        FileRegisterRequest.model_validate(
            {
                "filename": filename,
                "run_id": run["_id"],
                "source_system": "api",
                "role": "evaluator",
                "format": "PY",
                "size_bytes": size,
                "checksum_sha256": implementation["sha256"],
                "storage_ref": f"blob://{key}",
            }
        ),
        actor=actor,
    )
    logger.info(
        "implementation %s filed under run %s as %s (created=%s)",
        key,
        run["_id"],
        doc["_id"],
        created,
    )
    return doc


def lake_table(run: Mapping[str, Any]) -> str:
    """The lake table the run's samples live in; the API's own default when it names none."""
    return (run.get("lake_table") or "").strip() or queries_stats._lake_table()


def run_params(run: Mapping[str, Any], definition: Mapping[str, Any]) -> dict[str, str]:
    """The `QUIXLAB_PARAMS` the wrapper notebook declares. Never a secret: they are logged."""
    implementation = definition.get("implementation") or {}
    return {
        "run_id": run["_id"],
        "td_id": definition["_id"],
        "implementation_key": blob_key(implementation.get("blob_path")),
        "lake_table": lake_table(run),
        "entrypoint": (implementation.get("entrypoint") or "").strip() or DEFAULT_ENTRYPOINT,
    }


def _outcome(outputs: Mapping[str, Any]) -> tuple[str, dict]:
    """The stored outcome and evidence. A verdict outside the enum is an `error`."""
    raw = outputs.get("verdict")
    evidence = outputs.get("evidence")
    evidence = dict(evidence) if isinstance(evidence, dict) else {}
    outcome = str(raw or "").strip().lower()
    if outcome not in OUTCOMES:
        evidence["unrecognised_verdict"] = raw
        outcome = "error"
    return outcome, evidence


def _produced_at(outputs: Mapping[str, Any]) -> datetime:
    """When the implementation returned, as the notebook stated it; now when it did not."""
    stated = outputs.get("evaluated_at")
    try:
        parsed = datetime.fromisoformat(str(stated))
    except ValueError:
        logger.warning("definition run stated no usable evaluated_at (%r); using now", stated)
        return datetime.now(UTC)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _parameters(run: Mapping[str, Any], definition: Mapping[str, Any], job_id: str) -> str:
    # The Job id makes a re-poll of one Job find its own verdict instead of minting another.
    blob_path = (definition.get("implementation") or {}).get("blob_path") or ""
    return f"impl={blob_path}; table={lake_table(run)}; run_id={run['_id']}; job={job_id}"


def _input_file_ids(db: Database, run_id: str) -> list[str]:
    # The evaluator is the tool, not an input; its digest rides as `tool_version`.
    rows = db["files"].find(
        {"run_id": run_id, "status": "registered", "role": {"$ne": "evaluator"}}, {"_id": 1}
    )
    return sorted(str(row["_id"]) for row in rows)


def has_verdict(result: RunResult) -> bool:
    """Whether a finished Job's outputs carry a verdict to record."""
    return bool(result.outputs) and "verdict" in (result.outputs or {})


def record_verdict(
    db: Database,
    *,
    run: Mapping[str, Any],
    definition: Mapping[str, Any],
    result: RunResult,
    identity: Identity,
) -> dict:
    """Store the Job's verdict once and return the stored document.

    A second call for the same Job answers the document the first one stored.
    """
    td_id = definition["_id"]
    run_id = run["_id"]
    parameters = _parameters(run, definition, result.deployment_id)
    stored = db[COLLECTION].find_one(
        {"run_id": run_id, "result_key": result_key(td_id), "provenance.parameters": parameters}
    )
    if stored is not None:
        logger.info("verdict of job %s already stored as %s", result.deployment_id, stored["_id"])
        return stored
    outputs = result.outputs or {}
    outcome, evidence = _outcome(outputs)
    implementation = definition.get("implementation") or {}
    sha = str(implementation.get("sha256") or "")
    body = ResultCreateRequest.model_validate(
        {
            "run_id": run_id,
            "name": f"{td_id} verdict",
            "result_key": result_key(td_id),
            "description": definition.get("title"),
            "storage_ref": None,
            "provenance": {
                "tool": td_id,
                "tool_version": f"sha256:{sha[:12]}",
                "parameters": parameters,
                "input_file_ids": _input_file_ids(db, run_id),
                "produced_by": PRODUCED_BY,
                "produced_at": _produced_at(outputs),
            },
            "verdict": {
                "definition_id": td_id,
                "outcome": outcome,
                "evidence": evidence,
                "implementation_sha256": sha,
            },
        }
    )
    doc, replayed = _store_result(db, body, identity)
    logger.info(
        "verdict of job %s on run %s for %s stored as %s v%s: %s (replayed=%s)",
        result.deployment_id,
        run_id,
        td_id,
        doc["_id"],
        doc.get("version"),
        outcome,
        replayed,
    )
    return doc


def latest_verdict(db: Database, run_id: str, td_id: str) -> dict | None:
    """The newest stored verdict of this definition on this run, or None."""
    return db[COLLECTION].find_one(
        {"run_id": run_id, "result_key": result_key(td_id)}, sort=[("version", -1)]
    )
