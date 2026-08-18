"""ReqIF 1.2 -> canonical JSON. The only XML parser in the system (D1).

Mapping is by ``ATTRIBUTE-DEFINITION-*-REF`` (the definition's ``IDENTIFIER``),
never by position, so re-ordering attributes upstream cannot silently change a
field. Everything not in the mapping table lands in a passthrough *sidecar*
(``source/reqif-passthrough.json``) rather than inside the canonical document:
the canonical schema stays closed (``additionalProperties: false``), which is
what makes door validation meaningful, and byte-identity between the ReqIF path
and the JSON path stays provable.

Normalisation rules N1-N6 are implemented in ``xhtml_text`` (N1), here and in
``canonical``; both upload paths run the same N2-N6 code, and only N1 (XHTML
flattening) is exclusive to the ReqIF path. N1 is applied as **amended** - a
constrained XHTML subset rather than ``<xhtml:br/>`` alone - because the spec's
literal rule cannot parse the acceptance fixture the spec names; see
``xhtml_text`` and departure 13 of the architecture doc.
"""

import io
import posixpath
import zipfile
from xml.etree import ElementTree

import canonical
import ids
import xhtml_text
from validation import Problem, UploadRejected
from xhtml_text import local_name as _local

REQIF_SCHEMA_VERSION = "1.0.0"

# Canonical field per attribute-definition IDENTIFIER, plus how to read it.
FIELD_BY_DEFINITION: dict[str, tuple[str, str]] = {
    "AD-ID": ("id", "string"),
    "AD-TITLE": ("title", "string"),
    "AD-CHAPTER": ("chapter", "enum"),
    "AD-TEXT": ("text", "xhtml"),
    "AD-EARS-PATTERN": ("ears_pattern", "enum"),
    "AD-SYSTEM-STATES": ("system_states", "enum_multi"),
    "AD-RATIONALE": ("rationale", "xhtml"),
    "AD-SOURCE": ("source", "semicolon_list"),
    "AD-VERIFICATION-TAG": ("verification_tag", "enum"),
    "AD-VERIFICATION-METHOD": ("verification_method", "enum"),
    "AD-MEASURAND": ("measurand", "measurand"),
    "AD-STATUS": ("status", "enum"),
    "AD-REVISION": ("revision", "string"),
    "AD-FIGURE-REFS": ("figure_refs", "comma_sorted"),
    "AD-RELATED-REQS": ("related_reqs", "comma_sorted"),
    "AD-VERIFIED-BY": ("verified_by", "comma_sorted"),
}

# N5: absent optional strings become "", absent optional lists become [].
STRING_FIELDS = ("id", "title", "chapter", "text", "ears_pattern", "rationale",
                 "verification_tag", "verification_method", "status", "revision")
LIST_FIELDS = ("system_states", "source", "measurand", "figure_refs", "related_reqs",
               "verified_by")


def _children(node, name: str):
    return [child for child in node if _local(child.tag) == name]


def _first(node, name: str):
    for child in node:
        if _local(child.tag) == name:
            return child
    return None


def _descendants(root, name: str):
    return [node for node in root.iter() if _local(node.tag) == name]


class _Reject(Exception):
    """Internal: a single fatal mapping problem."""

    def __init__(self, problem: Problem) -> None:
        self.problem = problem
        super().__init__(problem.message)


def _xhtml_to_text(value_node, entity_id: str, field: str) -> str:
    """Amended N1 + N2-N4: flatten the accepted XHTML subset, then normalise.

    The subset and the flattening live in ``xhtml_text``; the rejection is
    turned into the ``xhtml_shape`` problem here so the reason code and the
    JSON pointer stay owned by the parser. N2-N4 run through
    ``canonical.normalise_text``, the same function the JSON upload path uses -
    which is what keeps the two paths convergent.
    """
    try:
        flattened = xhtml_text.flatten_the_value(_first(value_node, "THE-VALUE"))
    except xhtml_text.XhtmlSubsetError as exc:
        raise _Reject(
            Problem(
                code="xhtml_shape",
                message=f"{field}: {exc}",
                entity_id=entity_id,
                pointer=f"/{field}",
            )
        ) from exc
    return canonical.normalise_text(flattened)


def _collect_enum_values(root) -> dict[str, dict]:
    """``ENUM-VALUE`` identifier -> ``{other_content, long_name, key}``.

    ``chapter`` and friends take ``EMBEDDED-VALUE/@OTHER-CONTENT``, not
    ``LONG-NAME``: the display name may be prettified upstream, the machine
    token may not. ``key`` is the frozen ordinal that orders ``system_states``.
    """
    values: dict[str, dict] = {}
    for enum_value in _descendants(root, "ENUM-VALUE"):
        identifier = enum_value.get("IDENTIFIER")
        if not identifier:
            continue
        embedded = None
        for node in enum_value.iter():
            if _local(node.tag) == "EMBEDDED-VALUE":
                embedded = node
                break
        key_raw = embedded.get("KEY") if embedded is not None else None
        try:
            key = int(key_raw) if key_raw is not None else None
        except ValueError:
            key = None
        values[identifier] = {
            "other_content": (embedded.get("OTHER-CONTENT") if embedded is not None else None),
            "long_name": enum_value.get("LONG-NAME"),
            "key": key,
        }
    return values


def _collect_definitions(root) -> dict[str, str]:
    """Attribute-definition identifier -> its ``LONG-NAME`` (for diagnostics)."""
    definitions: dict[str, str] = {}
    for node in root.iter():
        local = _local(node.tag)
        if local.startswith("ATTRIBUTE-DEFINITION-"):
            identifier = node.get("IDENTIFIER")
            if identifier:
                definitions[identifier] = node.get("LONG-NAME") or identifier
    return definitions


def _definition_ref(value_node) -> str | None:
    definition = _first(value_node, "DEFINITION")
    if definition is None:
        return None
    for child in definition:
        if _local(child.tag).startswith("ATTRIBUTE-DEFINITION-") and child.text:
            return child.text.strip()
    return None


def _hierarchy_paths(root) -> dict[str, list[str]]:
    """SPEC-OBJECT identifier -> the SPEC-HIERARCHY path that contains it."""
    paths: dict[str, list[str]] = {}

    def walk(node, trail: list[str]) -> None:
        for hierarchy in _children(node, "SPEC-HIERARCHY"):
            label = hierarchy.get("LONG-NAME") or hierarchy.get("IDENTIFIER") or ""
            object_ref = None
            obj = _first(hierarchy, "OBJECT")
            if obj is not None:
                for child in obj:
                    if _local(child.tag) == "SPEC-OBJECT-REF" and child.text:
                        object_ref = child.text.strip()
            if object_ref:
                paths[object_ref] = [*trail, label]
            children = _first(hierarchy, "CHILDREN")
            if children is not None:
                walk(children, [*trail, label])

    for specification in _descendants(root, "SPECIFICATION"):
        children = _first(specification, "CHILDREN")
        if children is not None:
            walk(children, [specification.get("LONG-NAME") or ""])
    return paths


def _spec_relations(root) -> dict[str, list[dict]]:
    """Source SPEC-OBJECT identifier -> relations, kept for the sidecar only."""
    relations: dict[str, list[dict]] = {}
    for relation in _descendants(root, "SPEC-RELATION"):
        source = target = relation_type = None
        for child in relation:
            local = _local(child.tag)
            if local == "SOURCE":
                source = _ref_text(child, "SPEC-OBJECT-REF")
            elif local == "TARGET":
                target = _ref_text(child, "SPEC-OBJECT-REF")
            elif local == "TYPE":
                relation_type = _ref_text(child, "SPEC-RELATION-TYPE-REF")
        if source:
            relations.setdefault(source, []).append(
                {
                    "identifier": relation.get("IDENTIFIER"),
                    "type": relation_type,
                    "target": target,
                }
            )
    return relations


def _ref_text(node, name: str) -> str | None:
    for child in node:
        if _local(child.tag) == name and child.text:
            return child.text.strip()
    return None


def _read_value(kind: str, value_node, enums: dict[str, dict], entity_id: str, field: str):
    """Extract one attribute value in the shape the canonical schema wants."""
    if kind == "xhtml":
        return _xhtml_to_text(value_node, entity_id, field)

    if kind in ("enum", "enum_multi"):
        refs = [
            node.text.strip()
            for node in value_node.iter()
            if _local(node.tag) == "ENUM-VALUE-REF" and node.text
        ]
        resolved = []
        for ref in refs:
            entry = enums.get(ref)
            if entry is None:
                raise _Reject(
                    Problem(
                        code="unresolved_enum_ref",
                        message=f"{field}: ENUM-VALUE-REF {ref!r} is not defined in DATATYPES",
                        entity_id=entity_id,
                        pointer=f"/{field}",
                    )
                )
            token = entry["other_content"] or entry["long_name"] or ref
            resolved.append((entry["key"] if entry["key"] is not None else 0, token))
        if kind == "enum":
            return resolved[0][1] if resolved else ""
        # N6: multi-enums are ordered by the frozen KEY ordinal (state-machine
        # order), not by document order.
        return [token for _, token in sorted(resolved, key=lambda pair: pair[0])]

    raw = value_node.get("THE-VALUE")
    if raw is None:
        the_value = _first(value_node, "THE-VALUE")
        raw = the_value.text if the_value is not None else ""
    raw = raw or ""

    if kind == "string":
        return canonical.normalise_text(raw)
    if kind == "semicolon_list":
        return [canonical.normalise_text(part) for part in canonical.split_ordered(raw, "; ")]
    if kind == "comma_sorted":
        return canonical.split_sorted_unique(raw, ",")
    if kind == "measurand":
        return raw  # parsed by the caller so warnings can be collected
    raise ValueError(f"unknown attribute kind {kind!r}")


def parse_reqif(xml_bytes: bytes) -> tuple[list[dict], dict, list[str]]:
    """Parse a ``.reqif`` document.

    Returns ``(items, passthrough, warnings)``. ``items`` are canonical
    requirement documents in id order; ``passthrough`` is the sidecar keyed by
    requirement id.
    """
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as exc:
        raise UploadRejected(
            stage="reqif_parse",
            problems=[Problem(code="xml_parse_error", message=str(exc))],
        ) from exc

    enums = _collect_enum_values(root)
    definitions = _collect_definitions(root)
    hierarchy = _hierarchy_paths(root)
    relations = _spec_relations(root)

    items: list[dict] = []
    passthrough: dict[str, dict] = {}
    warnings: list[str] = []
    problems: list[Problem] = []

    for spec_object in _descendants(root, "SPEC-OBJECT"):
        identifier = spec_object.get("IDENTIFIER") or ""
        mapped: dict = {}
        unmapped: dict = {}
        values_node = _first(spec_object, "VALUES")
        raw_measurand = ""

        for value_node in list(values_node) if values_node is not None else []:
            definition_ref = _definition_ref(value_node)
            if definition_ref is None:
                continue
            target = FIELD_BY_DEFINITION.get(definition_ref)
            if target is None:
                unmapped[definitions.get(definition_ref, definition_ref)] = _raw_value(value_node)
                continue
            field, kind = target
            try:
                extracted = _read_value(kind, value_node, enums, identifier, field)
            except _Reject as reject:
                problems.append(reject.problem)
                continue
            if kind == "measurand":
                raw_measurand = extracted
            else:
                mapped[field] = extracted

        req_id = mapped.get("id", "")
        # ST-ACC-SECTION objects and any other non-requirement SPEC-OBJECT are
        # simply not requirements; they are not an error.
        if not ids.REQ_ID_RE.match(req_id):
            continue

        measurand, measurand_warnings = canonical.parse_measurand(raw_measurand)
        mapped["measurand"] = measurand
        warnings.extend(f"{req_id}: {warning}" for warning in measurand_warnings)

        for field in STRING_FIELDS:
            mapped.setdefault(field, "")
        for field in LIST_FIELDS:
            mapped.setdefault(field, [])
        mapped["schema_version"] = REQIF_SCHEMA_VERSION

        items.append(canonical.normalise_requirement(mapped))
        # ReqIF puts SPEC-OBJECT-TYPE-REF inside <TYPE> in some exports and directly
        # under the SPEC-OBJECT in others, so both are tried. The test is explicit
        # (``is not None`` plus ``len``) rather than ``or``: an Element's truth value
        # is its child count, which Python has deprecated and will remove, and the
        # two are not the same question - an empty <TYPE> carries no ref, so the
        # SPEC-OBJECT is still the place to look.
        type_node = _first(spec_object, "TYPE")
        type_holder = type_node if type_node is not None and len(type_node) else spec_object
        passthrough[req_id] = {
            "spec_object_identifier": identifier,
            "long_name": spec_object.get("LONG-NAME"),
            "last_change": spec_object.get("LAST-CHANGE"),
            "spec_type": _ref_text(type_holder, "SPEC-OBJECT-TYPE-REF"),
            "hierarchy_path": hierarchy.get(identifier, []),
            "spec_relations": relations.get(identifier, []),
            "unmapped_attributes": unmapped,
        }

    if problems:
        raise UploadRejected(stage="reqif_mapping", problems=problems)
    if not items:
        raise UploadRejected(
            stage="reqif_mapping",
            problems=[
                Problem(
                    code="no_requirements",
                    message=(
                        "no SPEC-OBJECT carried an AD-ID matching "
                        f"{ids.REQ_ID_RE.pattern}; nothing to store"
                    ),
                )
            ],
        )

    items.sort(key=lambda item: item["id"])
    return items, passthrough, warnings


def _raw_value(value_node) -> object:
    """Best-effort raw rendering of an unmapped attribute, for the sidecar."""
    if value_node.get("THE-VALUE") is not None:
        return value_node.get("THE-VALUE")
    refs = [
        node.text.strip()
        for node in value_node.iter()
        if _local(node.tag) == "ENUM-VALUE-REF" and node.text
    ]
    if refs:
        return refs
    the_value = _first(value_node, "THE-VALUE")
    if the_value is None:
        return None
    return "".join(the_value.itertext()).strip()


def parse_reqifz(zip_bytes: bytes) -> tuple[list[dict], dict, list[str], dict[str, bytes]]:
    """Parse a ``.reqifz`` archive: one ``.reqif`` plus figure attachments.

    Returns ``(items, passthrough, warnings, figures)`` where ``figures`` maps
    the file name (as it will be stored under ``source/figures/``) to bytes.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise UploadRejected(
            stage="reqif_parse",
            problems=[Problem(code="bad_archive", message=f"not a readable zip: {exc}")],
        ) from exc

    reqif_names = [name for name in archive.namelist() if name.lower().endswith(".reqif")]
    if len(reqif_names) != 1:
        raise UploadRejected(
            stage="reqif_parse",
            problems=[
                Problem(
                    code="bad_archive",
                    message=f"a .reqifz must contain exactly one .reqif, found {reqif_names}",
                )
            ],
        )

    items, passthrough, warnings = parse_reqif(archive.read(reqif_names[0]))
    figures = {
        posixpath.basename(name): archive.read(name)
        for name in archive.namelist()
        if name.lower().endswith(".svg")
    }
    return items, passthrough, warnings, figures
