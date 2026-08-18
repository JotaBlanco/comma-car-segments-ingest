"""Canonical serialisation and the N1-N6 normalisation rules (spec 1.1.1/1.1.2).

Two serialisations, one derived from the other:

* **hash form** - RFC 8785-style JCS: keys sorted lexicographically,
  ``separators=(",", ":")``, UTF-8, ``ensure_ascii=False``, no NaN/Inf.
  ``canonical_sha256`` is the SHA-256 of those bytes.
* **stored form** - ``json.dumps(obj, indent=2, sort_keys=True,
  ensure_ascii=False) + "\\n"``. A deterministic function of the same object,
  therefore also byte-identical across the two upload paths.

The normalisation rules are what make the ReqIF path and the JSON path
converge. They are idempotent by construction: applying them to already
normalised input is a no-op, which is what lets the JSON upload path reuse them
without a second parser.
"""

import hashlib
import json
import re
import unicodedata

# N3: any run of whitespace collapses to a single space. ``\n`` produced by
# ``<xhtml:br/>`` is protected by substituting a sentinel before the collapse.
_WS_RUN = re.compile(r"[^\S\n]+")
_MEASURAND_RE = re.compile(r"^(?P<name>.+?)\s*\[(?P<unit>[^\]]*)\]$")

# N6 for ``system_states``: the frozen state-machine ordinal, not authoring
# order (spec 1.1.1, the AD-SYSTEM-STATES row). The ReqIF path reads that order
# from the ``ENUM-VALUE`` ``KEY`` attributes; the JSON path has no KEY table, so
# the order is pinned here and applied to both paths - otherwise the same
# requirement uploaded as JSON with the states listed in authoring order hashes
# differently from the ReqIF export of itself, and the convergence proof of spec
# 1.1.2 fails on five of the 37 real requirements. Identical to the ``enum``
# order in ``schemas/requirement-1.0.0.schema.json`` and to ``DT-ENUM-STATE`` in
# the exporter's frozen ordinal table. Append only; never renumber.
SYSTEM_STATE_ORDER = (
    "Off",
    "Standby",
    "Active-Cruise",
    "Active-Follow",
    "Active-Hold",
    "Driver-Override",
    "Degraded-Fault",
)


def canonical_bytes(obj) -> bytes:
    """JCS-style canonical bytes. Rejects NaN/Inf rather than emitting them."""
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(obj) -> str:
    return hashlib.sha256(canonical_bytes(obj)).hexdigest()


def stored_bytes(obj) -> bytes:
    """The on-blob form: indented, key-sorted, newline-terminated."""
    text = json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False)
    return (text + "\n").encode("utf-8")


def set_canonical_sha256(item_hashes: list[str]) -> str:
    """SHA-256 over the concatenated *sorted* per-item canonical hashes.

    Sorting removes item order as a degree of freedom, so two uploads that
    contain the same items in a different order produce the same set hash.
    """
    joined = "".join(sorted(item_hashes)).encode("ascii")
    return hashlib.sha256(joined).hexdigest()


def nfc(text: str) -> str:
    """N2: Unicode NFC normalisation."""
    return unicodedata.normalize("NFC", text)


def normalise_text(text: str) -> str:
    """N2 + N3 + N4 applied to a free-text attribute.

    N4 is a *negative* rule and matters: punctuation is never normalised, so the
    decimal comma in ``3,5 m/s2`` survives verbatim. The text is normative and
    ISO 15622 uses the comma.
    """
    if text is None:
        return ""
    text = nfc(str(text))
    # Collapse horizontal whitespace runs but keep explicit newlines (<br/>).
    text = _WS_RUN.sub(" ", text)
    # Trim each line, then drop leading/trailing whitespace overall.
    text = "\n".join(line.strip() for line in text.split("\n"))
    return text.strip()


def order_system_states(states) -> list[str]:
    """N6 for ``system_states``: frozen ordinal order, unknown values last.

    An unrecognised state is kept (after the known ones, alphabetically) rather
    than dropped: normalisation runs *before* schema validation, so the value has
    to survive long enough for the validator to name it in the rejection.
    """
    index = {state: position for position, state in enumerate(SYSTEM_STATE_ORDER)}
    return sorted(
        states or [], key=lambda state: (index.get(state, len(index)), str(state))
    )


def split_ordered(raw: str, separator: str = "; ") -> list[str]:
    """Split, strip, drop empties, **preserve order** (provenance chains)."""
    if not raw:
        return []
    return [part.strip() for part in nfc(raw).split(separator) if part.strip()]


def split_sorted_unique(raw: str, separator: str = ",") -> list[str]:
    """Split, strip, dedupe, sort ascending (N6)."""
    if not raw:
        return []
    return sorted({part.strip() for part in nfc(raw).split(separator) if part.strip()})


def parse_measurand(raw: str) -> tuple[list[dict], list[str]]:
    """``"VehAccel_mps2 [m/s^2]; Foo [1]"`` -> list of ``{name, unit}``.

    Returns ``(items, warnings)``. An entry that does not match the
    ``name [unit]`` shape becomes ``{name: <raw>, unit: None}`` plus a warning -
    the spec asks for a warning, not a rejection, because ``measurand`` is
    authored free-hand upstream.
    """
    items: list[dict] = []
    warnings: list[str] = []
    for part in split_ordered(raw, "; "):
        match = _MEASURAND_RE.match(part)
        if match:
            unit = match.group("unit").strip()
            items.append({"name": match.group("name").strip(), "unit": unit or None})
        else:
            items.append({"name": part, "unit": None})
            warnings.append(f"measurand entry {part!r} has no [unit] suffix; unit set to null")
    return items, warnings


def normalise_requirement(doc: dict) -> dict:
    """Idempotent N2-N6 over a canonical requirement document.

    Applied to both upload paths. On the ReqIF path the parser has already
    produced these shapes; running the rules again must not change anything,
    which is exactly the property the convergence check depends on.
    """
    out = dict(doc)
    out["schema_version"] = out.get("schema_version", "1.0.0")

    for field in ("id", "title", "chapter", "ears_pattern", "verification_tag",
                  "verification_method", "status", "revision"):
        if field in out and out[field] is not None:
            out[field] = normalise_text(out[field])

    for field in ("text", "rationale"):
        out[field] = normalise_text(out.get(field, ""))

    # N6: order is by rule, not by authoring.
    out["source"] = [normalise_text(s) for s in out.get("source") or []]
    out["system_states"] = order_system_states(out.get("system_states"))
    for field in ("figure_refs", "related_reqs", "verified_by"):
        out[field] = sorted({normalise_text(v) for v in out.get(field) or [] if str(v).strip()})

    measurand = []
    for entry in out.get("measurand") or []:
        name = normalise_text(entry.get("name", ""))
        unit = entry.get("unit")
        measurand.append({"name": name, "unit": normalise_text(unit) if unit else None})
    out["measurand"] = measurand
    return out


def normalise_test_case(doc: dict) -> dict:
    """N2/N3 over the display-only strings of a test case.

    Machine fields (``pass_criteria``, ``window``, ``rule``) are left byte-exact:
    normalising a number or an enum would be a semantic change, not a
    presentation one.
    """
    out = dict(doc)
    out["schema_version"] = out.get("schema_version", "1.0.0")
    for field in ("title", "objective", "test_environment", "entry_criteria", "exit_criteria",
                  "notes"):
        if field in out and out[field] is not None:
            out[field] = normalise_text(out[field])
    if isinstance(out.get("preconditions"), dict):
        pre = dict(out["preconditions"])
        pre["prose"] = normalise_text(pre.get("prose", ""))
        out["preconditions"] = pre
    out["covers_req_ids"] = sorted(set(out.get("covers_req_ids") or []))
    if out.get("depends_on") is not None:
        out["depends_on"] = sorted(set(out["depends_on"]))
    return out


def loads(data: bytes):
    """Parse UTF-8 JSON, rejecting NaN/Infinity literals."""
    return json.loads(data.decode("utf-8"), parse_constant=_reject_constant)


def _reject_constant(name: str):
    raise ValueError(f"JSON constant {name!r} is not permitted in a canonical document")
