"""Test-implementation uploads: code to blob, metadata to a versioned set.

A ``test_impl`` version is the *whole* set, because a baseline pins one version
and must be able to resolve every case's ``impl_ref``. Uploading one
implementation therefore carries the previous version's items and code files
forward and adds or replaces one entry - the folder stays write-once (D4) while
the set stays complete.

Nothing here executes uploaded code. The unit-test runner is deferred out of
this phase by explicit decision; ``language`` values ``capl`` and ``etas`` are
accepted and stored, and a runner that cannot handle them reports
``not_run / unsupported_language`` rather than failing the case.
"""

import hashlib
import io
import logging
import posixpath
import zipfile

import artifact_store
import canonical
import ids
import validation
from artifact_store import ArtifactFile
from settings import SET_TEST_IMPL, VALIDATOR_VERSION
from upload_service import commit_set_version, safe_name
from validation import Problem, UploadRejected

logger = logging.getLogger(__name__)

MAX_CODE_FILES = 200


def _code_files_from_upload(filename: str, data: bytes) -> dict[str, bytes]:
    """``.py`` -> one file; ``.zip`` -> its entries, path-checked."""
    lowered = (filename or "").lower()
    if lowered.endswith(".py"):
        return {safe_name(filename): data}
    if not lowered.endswith(".zip") and data[:2] != b"PK":
        raise UploadRejected(
            stage="media_type",
            problems=[
                Problem(
                    code="unsupported_media_type",
                    message=f"{filename!r} must be a .py file or a .zip archive",
                )
            ],
        )
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise UploadRejected(
            stage="media_type",
            problems=[Problem(code="bad_archive", message=f"not a readable zip: {exc}")],
        ) from exc

    files: dict[str, bytes] = {}
    for info in archive.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        normalised = posixpath.normpath(name)
        if normalised.startswith(("/", "..")) or ":" in normalised:
            raise UploadRejected(
                stage="media_type",
                problems=[
                    Problem(
                        code="unsafe_archive_path",
                        message=f"archive entry {info.filename!r} escapes the code folder",
                    )
                ],
            )
        files[normalised] = archive.read(info)
        if len(files) > MAX_CODE_FILES:
            raise UploadRejected(
                stage="media_type",
                problems=[
                    Problem(
                        code="too_many_files",
                        message=f"archive holds more than {MAX_CODE_FILES} files",
                    )
                ],
            )
    if not files:
        raise UploadRejected(
            stage="media_type",
            problems=[Problem(code="empty_archive", message="archive contains no files")],
        )
    return files


def _file_records(code: dict[str, bytes]) -> list[dict]:
    records = []
    for path in sorted(code):
        blob = code[path]
        records.append(
            {
                "path": path,
                "size_bytes": len(blob),
                "sha256": hashlib.sha256(blob).hexdigest(),
                "lines": blob.count(b"\n") + (1 if blob and not blob.endswith(b"\n") else 0),
            }
        )
    return records


def ingest_test_impl(
    tc_id: str,
    language: str,
    entrypoint: str,
    filename: str,
    data: bytes,
    created_by: str,
    requirements_txt: bytes | None = None,
    timeout_s: int = 120,
    trace_required: bool = True,
    description: str = "",
    notes: str = "",
) -> dict:
    """Mint one immutable ``test_impl`` version containing this implementation."""
    if not ids.TC_ID_RE.match(tc_id):
        raise UploadRejected(
            stage="cross_field",
            problems=[
                Problem(
                    code="schema_violation",
                    message=f"tc_id {tc_id!r} must match {ids.TC_ID_RE.pattern}",
                    entity_id=tc_id,
                )
            ],
        )

    code = _code_files_from_upload(filename, data)
    if requirements_txt is not None:
        code["requirements.txt"] = requirements_txt
    if entrypoint not in code:
        raise UploadRejected(
            stage="cross_field",
            problems=[
                Problem(
                    code="unresolved_entrypoint",
                    message=(
                        f"entrypoint {entrypoint!r} is not in the upload; "
                        f"files are {sorted(code)}"
                    ),
                    entity_id=tc_id,
                )
            ],
        )

    item = {
        "schema_version": "1.0.0",
        "impl_id": tc_id,
        "language": language,
        "entrypoint": entrypoint,
        "runtime": "python:3.12",
        "timeout_s": timeout_s,
        "trace_required": trace_required,
        "files": _file_records(code),
        "requirements_txt": "requirements.txt" if "requirements.txt" in code else None,
        "description": canonical.normalise_text(description),
        "uploaded_utc": ids.utc_now_iso(),
        "uploaded_by": created_by,
    }

    carried_items, carried_files = _carry_forward(exclude_tc_id=tc_id)
    items = sorted([*carried_items, item], key=lambda entry: entry["impl_id"])
    validation.run_door_validation(SET_TEST_IMPL, items)

    files: list[ArtifactFile] = [
        ArtifactFile("canonical/test-impl.json", canonical.stored_bytes({"items": items}))
    ]
    for entry in items:
        files.append(
            ArtifactFile(
                f"canonical/items/{entry['impl_id']}.json", canonical.stored_bytes(entry)
            )
        )
    files.extend(carried_files)
    for path in sorted(code):
        files.append(ArtifactFile(f"code/{tc_id}/{path}", code[path]))
    files.append(ArtifactFile(f"source/{safe_name(filename)}", data))

    upload_kind = "py" if safe_name(filename).lower().endswith(".py") else "zip"
    result = commit_set_version(
        SET_TEST_IMPL, items, files, filename, data, upload_kind, created_by, [], notes
    )
    logger.info(
        "test_impl %s now contains %d implementations (validator %s)",
        result["version"], len(items), VALIDATOR_VERSION,
    )
    return result


def _carry_forward(exclude_tc_id: str) -> tuple[list[dict], list[ArtifactFile]]:
    """Previous version's items and code, minus the one being replaced."""
    parent = artifact_store.latest_version(SET_TEST_IMPL)
    if parent is None:
        return [], []
    previous = artifact_store.read_items(SET_TEST_IMPL, parent)
    items: list[dict] = []
    files: list[ArtifactFile] = []
    for impl_id, entry in sorted(previous.items()):
        if impl_id == exclude_tc_id:
            continue
        items.append(entry)
        for record in entry.get("files", []):
            blob = artifact_store.read_impl_code(parent, impl_id, record["path"])
            files.append(ArtifactFile(f"code/{impl_id}/{record['path']}", blob))
    return items, files


def preview_code(version: str, tc_id: str, entrypoint: str, max_lines: int = 200) -> dict:
    """First ``max_lines`` lines of an implementation, for the thin page-3 view."""
    blob = artifact_store.read_impl_code(version, tc_id, entrypoint)
    text = blob.decode("utf-8", errors="replace")
    lines = text.splitlines()
    return {
        "tc_id": tc_id,
        "entrypoint": entrypoint,
        "size_bytes": len(blob),
        "line_count": len(lines),
        "truncated": len(lines) > max_lines,
        "preview": "\n".join(lines[:max_lines]),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }
