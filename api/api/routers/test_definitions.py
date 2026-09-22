"""Test-definition routes. Owner: Lane A.

The list read is built — TR-001 asks the screen to flag an orphaned
definition, and no other route can answer that. The detail read is built too:
the definition was the one node of the traceability chain a person could not
click (FR-DM-074).

The mirror is read-only for every planning field. Planning owns the title, the
work order and the plan, so no route here writes one.

**Two fields bend that rule, on purpose: the requirements documents and the
custom properties.** A person writes both through the routes at the foot of
this file. Both live in their own store beside the planning fields, so a sync
pass replaces what planning owns and never touches a person's work.
"""

import re
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from pymongo.database import Database
from pymongo.errors import PyMongoError

from api.auth import journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import Pagination, Source, pagination_params
from api.models.planning import (
    DefinitionCustomProperties,
    DefinitionCustomPropertiesRequest,
    RequirementsFile,
    RequirementsFileEdit,
    RequirementsFileUpload,
    TestDefinitionDetail,
    TestDefinitionPage,
    default_render_markdown,
)
from api.provenance import add_event, set_field
from api.quix_identity import Identity
from api.services import queries_runs
from api.services.file_bytes import (
    CHUNK_BYTES,
    FileBytesProvider,
    FileBytesUnavailable,
    content_disposition,
    get_file_bytes_provider,
)
from api.services.file_writes import (
    FileBytesWriter,
    get_file_writer,
    requirements_blob_key,
)

# The store a person writes. Planning writes `requirements_files`, and the two
# never share a field, so a sync pass can never delete a manual document.
MANUAL_FIELD = "manual_requirements_files"

# The second store this router writes: the custom property map. It reads the
# one name the service states, so the write route and the detail read can never
# name different fields.
MANUAL_PROPERTIES_FIELD = queries_runs.MANUAL_PROPERTIES_FIELD

# 256 KiB of UTF-8. A requirements document is prose that a person reads. A
# larger body is a mistake or an abuse, and never a document.
MAX_CONTENT_BYTES = 256 * 1024

# 25 MiB on the BINARY route. The text cap is 256 KiB, and a PDF, a Word file,
# a spreadsheet or a screenshot passes that cap in the first page. 25 MiB holds
# a scanned 100-page specification at 300 dpi with room to spare, and it stays
# far under the 100 MiB result cap, so a raw measurement file can never enter
# through this door. A measurement file reaches the system through ingestion.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# The multipart envelope around the file: the boundaries, the headers and the
# name part. The early Content-Length check allows this much on top of the file
# cap, so it never refuses a file the exact check would pass. The result upload
# route allows the same margin.
MULTIPART_OVERHEAD_BYTES = 64 * 1024

# The tail of the multipart upload path. The route class matches on it.
_UPLOAD_SUFFIX = "/requirements-files/upload"

# A media type is `type/subtype` with optional `; parameter=value` parts. The
# route stores a value that matches, and `application/octet-stream` otherwise.
# The stored value is a DISPLAY LABEL. Nothing reads it to pick a code path.
_MEDIA_TYPE_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+/[A-Za-z0-9!#$%&'*+.^_`|~-]+$")

# The type the route stores when the browser states nothing usable.
DEFAULT_CONTENT_TYPE = "application/octet-stream"


def _refuse_an_oversized_body(request: Request) -> None:
    """Answer 413 for a stated body length above the cap.

    The check reads `MAX_UPLOAD_BYTES` from the module on every call, so a test
    that shrinks the cap shrinks this guard too.
    """
    stated = request.headers.get("content-length", "")
    if not stated.isdigit():
        return
    if int(stated) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES:
        raise ApiError(
            413,
            f"the file is larger than the {MAX_UPLOAD_BYTES} byte cap",
            "file_too_large",
        )


class _CappedUploadRoute(APIRoute):
    """Refuse an oversized upload before Starlette spools the body to disk.

    FastAPI reads the multipart body **before** it solves a dependency, so no
    dependency and no line of the route function can guard the spool. The route
    handler runs earlier than both, so the cheap check lives here: a stated
    Content-Length above the cap answers 413 and nothing is read. This copies
    `api/api/routers/results.py`, which proved the pattern on the result upload.

    A request that states no length (a chunked body) still meets the exact cap
    in `_read_within_cap`, so the guard never depends on the header alone.
    """

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            if request.url.path.endswith(_UPLOAD_SUFFIX):
                _refuse_an_oversized_body(request)
            return await original(request)

        return handler


router = APIRouter(tags=["test-definitions"], route_class=_CappedUploadRoute)


@router.get("/test-definitions")
def list_test_definitions(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    orphaned: bool | None = None,
) -> TestDefinitionPage:
    """List the mirrored test definitions, orphans flagged (TR-001).

    `orphaned=true` lists the orphans, `orphaned=false` the linked rows, and
    no param lists both. The sort is fixed on the id, lowest first, and the
    route takes no sort param.
    """
    return queries_runs.list_test_definitions(db, pagination, orphaned=orphaned)


@router.get("/test-definitions/{td_id}")
def get_test_definition(
    td_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> TestDefinitionDetail:
    """Read one definition, its work order and the runs that carry it.

    404 when the mirror holds no such definition. The work order is null on an
    orphan, exactly as the list's `orphaned` flag reports it.
    """
    return queries_runs.get_test_definition_detail(db, td_id)


# --- the manual requirements documents --------------------------------------
#
# The mirror rule says planning owns a test definition. These two routes bend
# it for ONE field. A manual document lives beside the planning documents in
# its own store, and neither side ever overwrites the other: a sync pass
# replaces the planning list only, and these routes write the manual list only.
# A name may appear in both stores, and both documents stay.


def _definition(db: Database, td_id: str) -> dict:
    """Read one mirrored definition, or refuse with the read route's 404."""
    definition = db["test_definitions"].find_one({"_id": td_id})
    if definition is None:
        raise ApiError(404, f"Test definition {td_id} not found", "td_not_found")
    return definition


@router.post("/test-definitions/{td_id}/requirements-files", status_code=201)
def upload_requirements_file(
    td_id: str,
    body: RequirementsFileUpload,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RequirementsFile:
    """Attach one requirements document to a definition by hand.

    The caller states a name and the text. The server states the source, the
    moment and the actor, so nobody can claim to be planning or another person
    (`plans/design/MANUAL-ATTACH.md` §5).

    A second post of the same name REPLACES the manual document of that name,
    and it journals the replacement. It never reads and never writes a planning
    document, so a document planning sent under the same name stays.

    `render_markdown` says how the screen renders the text. An absent flag takes
    the default off the name: a `.md` name renders as markdown, and every other
    name renders as plain text.

    The refusals: 404 when the mirror holds no such definition, 422 on an empty
    name or empty text, and 413 above 256 KiB of UTF-8.
    """
    name = body.name.strip()
    if not name:
        raise ApiError(422, "the requirements file needs a name", "name_required")
    if not body.content.strip():
        raise ApiError(422, "the requirements file needs content", "content_required")
    size = len(body.content.encode("utf-8"))
    if size > MAX_CONTENT_BYTES:
        raise ApiError(
            413,
            f"the content is {size} bytes and the cap is {MAX_CONTENT_BYTES} bytes",
            "file_too_large",
        )

    definition = _definition(db, td_id)
    # A person pressed Upload, so the actor is the verified caller and never a
    # name the body states. The body states no actor at all.
    actor = journal_actor_or_id(identity, identity.display_name)

    render_markdown = body.render_markdown
    if render_markdown is None:
        render_markdown = default_render_markdown(name)
    document = {
        "name": name,
        "content": body.content,
        "source": "manual",
        "updated_at": datetime.now(UTC),
        "updated_by": str(actor),
        "render_markdown": render_markdown,
        # A text document holds no bytes anywhere else.
        "storage_ref": None,
        "content_type": None,
        "size_bytes": None,
    }
    _replace(db, td_id, definition, document, actor)
    return document


def _replace(
    db: Database, td_id: str, definition: dict, document: dict, actor: str
) -> None:
    """Journal one manual document write, then put the document in the store.

    A second write of the same name REPLACES the manual document of that name.
    The text route and the multipart route both call this, so one rule keeps
    both: a manual write never reads and never writes a planning document.

    **The entry lands before the row**, the order `POST /results/upload` keeps.
    A refused entry then leaves no document nobody can account for. The two
    writes are not atomic, so a crash between them loses the document and never
    the audit line, and the caller writes the document again.
    """
    stored = definition.get(MANUAL_FIELD) or []
    kept = [held for held in stored if held["name"] != document["name"]]
    replaced = len(kept) != len(stored)
    _journal(db, td_id, "replaced" if replaced else "added", document["name"], actor)
    db["test_definitions"].update_one(
        {"_id": td_id}, {"$set": {MANUAL_FIELD: [*kept, document]}}
    )


def _manual_document(definition: dict, td_id: str, name: str) -> tuple[list, int]:
    """Find one manual document by name, or refuse the way the delete route does.

    It answers the stored list and the index inside it, so a caller replaces
    one document in place and keeps the order of the store.

    A name that only planning holds answers 409 `planning_owned_file`: a person
    owns the manual store, and never a planning document. Any other unknown
    name answers 404 `requirements_file_not_found`.
    """
    stored = definition.get(MANUAL_FIELD) or []
    for index, held in enumerate(stored):
        if held["name"] == name:
            return stored, index
    planning = definition.get("requirements_files") or []
    if any(document["name"] == name for document in planning):
        raise ApiError(
            409,
            f"planning owns the requirements file {name}; the registry never changes one",
            "planning_owned_file",
        )
    raise ApiError(
        404,
        f"Test definition {td_id} holds no manual requirements file {name}",
        "requirements_file_not_found",
    )


def _edit_note(name: str, before: str, after: str, was: bool, now: bool) -> str:
    """State what one edit changed, and never carry the text itself.

    A requirements document reaches 256 KiB, so an entry that quoted the text
    would grow the history by a whole document on every edit, and a reader
    would then pay more to read the journal than to read the document. The
    entry states the size on both sides in bytes instead. A reader sees the
    direction and the scale of the change, and the document stays the one place
    the text lives.

    The flag reads `on` and `off`, because a reader of a history reads words.
    """
    if before == after:
        content = "The content did not change."
    else:
        content = (
            f"The content changed from {len(before.encode('utf-8'))} to "
            f"{len(after.encode('utf-8'))} bytes."
        )
    words = {True: "on", False: "off"}
    if was == now:
        flag = f"The markdown flag stayed {words[now]}."
    else:
        flag = f"The markdown flag went from {words[was]} to {words[now]}."
    return f"Edited the requirements file {name}. {content} {flag}"


@router.patch("/test-definitions/{td_id}/requirements-files/{name}")
def edit_requirements_file(
    td_id: str,
    name: str,
    body: RequirementsFileEdit,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RequirementsFile:
    """Change the text of one manual TEXT document, and journal what changed.

    The path names the document. **The route never changes the name**: the name
    is the identity here, and a rename is a different operation this registry
    does not have. The body carries `content` and the optional
    `render_markdown`, and an absent flag keeps the stored one.

    Every gate of the add route holds: the same token, the same 256 KiB cap,
    the same `manual` source, and the same rule that the server states the
    actor and the moment. A person owns the manual store only.

    The refusals: 404 `td_not_found`, 404 `requirements_file_not_found`, 409
    `planning_owned_file` (planning owns that name), 409
    `requirements_file_has_no_text` (the document holds bytes, so a person
    replaces it by uploading it again), 422 `content_required`, 413
    `file_too_large`.

    The journal entry names the sizes on both sides and the markdown flag on
    both sides. It never carries the text - see :func:`_edit_note`.
    """
    if not body.content.strip():
        raise ApiError(422, "the requirements file needs content", "content_required")
    size = len(body.content.encode("utf-8"))
    if size > MAX_CONTENT_BYTES:
        raise ApiError(
            413,
            f"the content is {size} bytes and the cap is {MAX_CONTENT_BYTES} bytes",
            "file_too_large",
        )

    definition = _definition(db, td_id)
    stored, index = _manual_document(definition, td_id, name)
    held = stored[index]
    if (held.get("storage_ref") or "").strip():
        # The mirror of the download's 409: that route refuses to stream a text
        # document, and this one refuses to type over a binary one. Bytes are
        # replaced by uploading them again.
        raise ApiError(
            409,
            f"The requirements file {name} holds bytes, not text, so typing "
            "cannot change it. Upload the file again to replace the bytes.",
            "requirements_file_has_no_text",
        )

    # A row written before the flag existed carries no key, and the detail read
    # fills it from the name. The journal has to name the value the reader saw
    # on the screen, so it reads the flag through that same rule.
    was = held.get("render_markdown")
    if was is None:
        was = default_render_markdown(name)
    render_markdown = was if body.render_markdown is None else body.render_markdown

    # A person pressed Save, so the actor is the verified caller. The body
    # states no actor, exactly as the add route takes none.
    actor = journal_actor_or_id(identity, identity.display_name)
    document = {
        **held,
        "content": body.content,
        "source": "manual",
        "updated_at": datetime.now(UTC),
        "updated_by": str(actor),
        "render_markdown": render_markdown,
    }
    # The entry lands before the row, the order `_replace` keeps. A refused
    # entry then leaves no change nobody can account for.
    _journal(
        db,
        td_id,
        "edited",
        name,
        actor,
        note=_edit_note(
            name, held.get("content") or "", body.content, was, render_markdown
        ),
    )
    db["test_definitions"].update_one(
        {"_id": td_id},
        {"$set": {MANUAL_FIELD: [*stored[:index], document, *stored[index + 1 :]]}},
    )
    return document


@router.delete("/test-definitions/{td_id}/requirements-files/{name}", status_code=204)
def delete_requirements_file(
    td_id: str,
    name: str,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> None:
    """Remove one manual requirements document, and journal the removal.

    It removes a manual document only. Planning owns its own documents, so a
    name that only planning holds answers 409 and nothing is removed. A name
    that both stores hold removes the manual document and keeps the planning
    one.
    """
    definition = _definition(db, td_id)
    stored = definition.get(MANUAL_FIELD) or []
    kept = [document for document in stored if document["name"] != name]
    if len(kept) == len(stored):
        planning = definition.get("requirements_files") or []
        if any(document["name"] == name for document in planning):
            raise ApiError(
                409,
                f"planning owns the requirements file {name}; the registry never removes one",
                "planning_owned_file",
            )
        raise ApiError(
            404,
            f"Test definition {td_id} holds no manual requirements file {name}",
            "requirements_file_not_found",
        )

    actor = journal_actor_or_id(identity, identity.display_name)
    db["test_definitions"].update_one({"_id": td_id}, {"$set": {MANUAL_FIELD: kept}})
    _journal(db, td_id, "removed", name, actor)


def _journal(
    db: Database, td_id: str, verb: str, name: str, actor: str, note: str | None = None
) -> None:
    """Record one manual document write. Every manual write leaves one entry.

    `MANUAL-ATTACH.md` §6 states the rule: a manual attachment is a human
    decision, so the journal names the real person who made it.

    `note` states what the write changed. The add, the replace and the remove
    each change a whole document, so the default sentence says everything. An
    edit changes a part of one, so the edit route states its own sentence.
    """
    entry = add_event(
        "test_definition",
        td_id,
        f"test_definition.requirements_file_{verb}",
        Source.MANUAL,
        actor,
        note=note or f"{verb.capitalize()} the requirements file {name}.",
    )
    db["journal_entries"].insert_one(entry)


# --- the manual custom properties ---------------------------------------------
#
# The second field a person owns on a read-only mirror, and it follows the
# requirements-document rule above: the map lives in its own store, planning
# names no such field, and a sync pass therefore never reaches it. The wire
# calls it `custom_properties`; the store calls it `manual_custom_properties`,
# so nobody reads it as a planning field.


@router.patch("/test-definitions/{td_id}/custom-properties")
def set_custom_properties(
    td_id: str,
    body: DefinitionCustomPropertiesRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> DefinitionCustomProperties:
    """Replace the custom property map of one definition.

    The body states the whole map, never a merge, exactly as
    `PATCH /test-runs/{run_id}` does. An empty object clears every property.
    The caps and the refusal codes are the run's: `api/api/models/runs.py`
    holds the one checker both routes call.

    A map equal to the stored one writes nothing and journals nothing, so the
    history carries edits and not noise.

    The refusals: 404 `td_not_found`, 422 `custom_property_key_required`, 422
    `custom_property_key_too_long`, 422 `custom_property_value_too_long` and
    422 `too_many_custom_properties`.
    """
    definition = _definition(db, td_id)
    stored = definition.get(MANUAL_PROPERTIES_FIELD) or {}
    properties = dict(body.custom_properties)
    if properties == stored:
        return {"custom_properties": stored}

    # A person pressed Save, so the actor is the verified caller. The body
    # states no actor, the way the two document routes state none.
    actor = journal_actor_or_id(identity, identity.display_name)
    update: dict = {}
    # The provenance helper writes the value, the `manual` source tag and the
    # journal entry together. No route writes a source tag by hand.
    entry = set_field(
        update,
        MANUAL_PROPERTIES_FIELD,
        properties,
        Source.MANUAL,
        actor,
        note=body.note,
        current_doc=definition,
        entity_type="test_definition",
        entity_id=td_id,
        field_label="test_definition.custom_properties",
    )
    if entry is None:
        # Precedence blocked the write, so `update` is empty and an empty $set
        # raises. It cannot happen today — a manual write never outranks itself
        # — but the guard keeps the route honest if the ranks ever move.
        return {"custom_properties": stored}
    db["test_definitions"].update_one({"_id": td_id}, {"$set": update})
    db["journal_entries"].insert_one(entry)
    return {"custom_properties": properties}
# --- a binary requirements document -----------------------------------------
#
# A requirement does not always arrive as text. A person holds a PDF, a Word
# file, a spreadsheet or a photograph of a rig, and the text route takes none
# of them. The two routes below carry the bytes, and they copy
# `POST /results/upload` and `GET /results/{result_id}/download` line for line:
# one cap before the spool, one exact cap over the chunks, one blob store, one
# `storage_ref`, and the same two 503 codes. No byte reaches Mongo.


def _read_within_cap(upload: UploadFile) -> int:
    """Read the upload in chunks and return the byte count.

    The route holds one 1 MiB chunk at a time and never the whole file. The cap
    refuses a file that passes it, and that refusal comes **before** any byte
    reaches the store, so a refused upload stores nothing.
    """
    size = 0
    upload.file.seek(0)
    while True:
        chunk = upload.file.read(CHUNK_BYTES)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise ApiError(
                413,
                f"the file is larger than the {MAX_UPLOAD_BYTES} byte cap",
                "file_too_large",
            )
    upload.file.seek(0)
    return size


def _chunks(upload: UploadFile) -> Iterator[bytes]:
    """Yield the upload one chunk at a time, for the writer."""
    while True:
        chunk = upload.file.read(CHUNK_BYTES)
        if not chunk:
            return
        yield chunk


def _display_content_type(stated: str | None) -> str:
    """Keep the type the browser stated, for display only.

    The browser picks the type from the file extension and a caller may state
    anything, so this value is a label a screen prints and nothing more. It
    never picks a code path here: the same store, the same cap and the same
    stream serve every type.

    A value that is not `type/subtype` becomes `application/octet-stream`, so a
    stored label can never carry a newline into a response header. The
    parameters after the media type (`; charset=...`) go, because no screen
    reads one.
    """
    media_type = (stated or "").split(";", 1)[0].strip()
    if not media_type or not _MEDIA_TYPE_RE.match(media_type):
        return DEFAULT_CONTENT_TYPE
    return media_type.lower()


@router.post("/test-definitions/{td_id}/requirements-files/upload", status_code=201)
def upload_requirements_file_bytes(
    td_id: str,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    writer: Annotated[FileBytesWriter, Depends(get_file_writer)],
    file: Annotated[UploadFile, File()],
    name: Annotated[str | None, Form()] = None,
) -> RequirementsFile:
    """Attach one BINARY requirements document to a definition.

    The request is `multipart/form-data`. `file` carries the bytes. `name` is
    optional and names the document; an absent name takes the filename.

    The order of the checks copies `POST /results/upload`:

    1. the stated body length, before Starlette spools it - 413 `file_too_large`;
    2. the name - 422 `name_required`;
    3. the exact size cap over the chunks - 413 `file_too_large` stores nothing;
    4. an empty file - 422 `content_required`;
    5. the definition - 404 `td_not_found`, and no byte is stored;
    6. the store answers - 503 `storage_unreachable`, and **no** journal entry;
    7. the bytes;
    8. the audit entry - 503 `not_ready`;
    9. the document row.

    **The audit entry lands after the bytes, and this route only**, exactly as
    the result upload orders it. An entry that says "Uploaded 4,096 bytes"
    before the store has taken them describes bytes that may never land. The
    download route keeps the other order, because a read must leave a trace
    even when the read then fails.

    A person pressed Upload, so the actor is the verified caller, the source is
    `manual`, and every gate of the text route holds here: the same token, the
    same journal entry, and the same rule that a manual document never
    overwrites a planning one.

    A binary document carries no markdown flag: `render_markdown` reads null.
    """
    document_name = (name or file.filename or "").strip()
    if not document_name:
        raise ApiError(422, "the requirements file needs a name", "name_required")

    size = _read_within_cap(file)
    if size == 0:
        raise ApiError(422, "the requirements file needs content", "content_required")

    definition = _definition(db, td_id)

    # Reach the store before the bytes, the way the download route reaches the
    # bytes before it answers.
    try:
        writer.check_ready()
    except FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error

    key = requirements_blob_key(td_id, file.filename or document_name)
    try:
        writer.write(key, _chunks(file))
    except FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error

    actor = journal_actor_or_id(identity, identity.display_name)
    document = {
        "name": document_name,
        # A binary document holds no text. The bytes live behind `storage_ref`.
        "content": "",
        "source": "manual",
        "updated_at": datetime.now(UTC),
        "updated_by": str(actor),
        "render_markdown": None,
        "storage_ref": f"blob://{key}",
        "content_type": _display_content_type(file.content_type),
        "size_bytes": size,
    }
    try:
        _replace(db, td_id, definition, document, actor)
    except PyMongoError as error:
        # The bytes are in the store, and nothing points at them. That is the
        # safe end: a stored object nobody reads costs space, and a document
        # row with no audit line costs the audit story.
        raise ApiError(
            503,
            "the upload event could not be recorded - refusing to store the document",
            "not_ready",
        ) from error
    return document


@router.get("/test-definitions/{td_id}/requirements-files/{name}/download")
def download_requirements_file(
    td_id: str,
    name: str,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    bytes_provider: Annotated[FileBytesProvider, Depends(get_file_bytes_provider)],
) -> Response:
    """Stream the stored bytes of one binary requirements document.

    The route mirrors `GET /results/{result_id}/download`, and it keeps
    **audit-before-bytes**: the server writes the journal entry before the
    first byte leaves, and a refused entry answers 503 and moves nothing.

    A name that both stores hold resolves to the manual document, which is the
    order the detail read already lists them in.

    Errors:

    * ``404 td_not_found`` - the mirror holds no such definition.
    * ``404 requirements_file_not_found`` - no document carries that name.
    * ``409 requirements_file_has_no_bytes`` - the document is text, so this
      registry holds no bytes for it. The detail read already carries the text.
    * ``503 storage_unreachable`` - the store did not answer, or it holds no
      object under the reference. No journal entry is written.
    * ``503 not_ready`` - the audit journal write failed. No bytes move.

    The answer states `Content-Disposition: attachment` and `nosniff`, so a
    stored `text/html` label can never render a document as a page on this
    origin. The screen still reads the type off the answer and shows an image
    or a PDF inline from the bytes it holds.
    """
    definition = _definition(db, td_id)
    documents = queries_runs.requirements_files(definition)
    document = next((held for held in documents if held["name"] == name), None)
    if document is None:
        raise ApiError(
            404,
            f"Test definition {td_id} holds no requirements file {name}",
            "requirements_file_not_found",
        )

    storage_ref = (document.get("storage_ref") or "").strip()
    if not storage_ref:
        # A text document is complete and correct - the detail read carries its
        # content already. A 404 here would read as "no such document".
        raise ApiError(
            409,
            f"The requirements file {name} holds text, not bytes, so this "
            "registry has nothing to stream.",
            "requirements_file_has_no_bytes",
        )

    # Reach for the bytes FIRST - before the journal write - so an unreachable
    # store never leaves a fake trace behind. `open` returns an iterator that
    # has not started, so no data byte moves before the entry lands.
    try:
        stream, size = bytes_provider.open(storage_ref)
    except FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error

    actor = journal_actor_or_id(identity, identity.display_name)
    entry = add_event(
        "test_definition",
        td_id,
        "test_definition.requirements_file_downloaded",
        Source.MANUAL,
        actor,
        note=f"Downloaded the requirements file {name} ({size} bytes).",
    )
    try:
        db["journal_entries"].insert_one(entry)
    except PyMongoError as error:
        # Audit-before-bytes forbids the download without a recorded trace.
        stream.close()
        raise ApiError(
            503,
            "the download event could not be recorded - refusing to serve bytes",
            "not_ready",
        ) from error

    return StreamingResponse(
        stream,
        # The stored label rides the answer for display. `attachment` and
        # `nosniff` stop the browser rendering it as a page on this origin, so
        # a wrong or hostile label decides nothing.
        media_type=document.get("content_type") or DEFAULT_CONTENT_TYPE,
        headers={
            "Content-Disposition": content_disposition(name),
            "Content-Length": str(size),
            "X-Content-Type-Options": "nosniff",
            "X-Journal-Id": entry["_id"],
            "Cache-Control": "no-store",
        },
    )
