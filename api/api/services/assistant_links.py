"""The assistant's deep-link builder: model proposals in, app-relative URLs out.

The FE keeps its whole table state in the URL (``frontend/lib/table-state.ts``),
so the best answer to "which runs failed on RIG-04?" is a link to the runs
screen with those exact filters. This module is the second implementation of
that param grammar (priced as its own line in AI-SIDEBAR AS-3), and it is the
ONLY way a URL enters an assistant frame: the model proposes ``{screen,
params}``, this module validates against a whitelist and either builds the URL
or returns None — a dropped link, never a guessed one.

Every produced URL is app-relative (starts with "/"). Values are URL-encoded,
so a hostile value ("javascript:...", an external URL) can only ever travel as
an inert query value, never as a clickable scheme or host.
"""

from urllib.parse import quote

# Filter screens: path, and the allowed query keys IN ORDER. Each key maps to
# (multi, allowed_values) — ``multi`` says whether the key may repeat,
# ``allowed_values`` is a closed value set or None for free text. The key order
# here is the order of the built query string, so links are deterministic and
# testable byte-for-byte.
_FILTER_SCREENS: dict[str, tuple[str, tuple[tuple[str, bool, frozenset | None], ...]]] = {
    "runs": (
        "/runs",
        (
            ("status", True, frozenset({"complete", "awaiting_work_order", "invalid"})),
            ("rig", True, None),
            ("project", True, None),
            ("work_order", False, None),
            ("definition", False, None),
            ("signal", False, None),
            ("q", False, None),
        ),
    ),
    "files": (
        "/files",
        (
            ("status", True, frozenset({"registered", "quarantined"})),
            ("source_system", True, frozenset({"TAS", "INCA", "ifile"})),
            ("run", False, None),
            ("unlinked", False, frozenset({"true"})),
            ("q", False, None),
        ),
    ),
    "work-orders": (
        "/work-orders",
        (
            ("status", True, frozenset({"active", "closed"})),
            ("project", True, None),
            ("q", False, None),
        ),
    ),
    "signals": (
        "/signals",
        (
            ("unit", True, None),
            ("rig", True, None),
            ("missing_unit", False, frozenset({"true"})),
            ("q", False, None),
        ),
    ),
}

# Detail screens: id in, one path out. The id key is "name" for the signal
# screen because that screen routes on the signal name, not an opaque id.
_DETAIL_SCREENS: dict[str, tuple[str, str]] = {
    "run-detail": ("/runs/{}", "id"),
    "run-lineage": ("/runs/{}/lineage", "id"),
    "work-order-detail": ("/work-orders/{}", "id"),
    "file-detail": ("/files/{}", "id"),
    "signal-detail": ("/signals/{}", "name"),
}


def _values(raw, multi: bool, allowed: frozenset | None) -> list[str]:
    """Normalize one param to its usable string values; [] drops the key.

    A scalar or a list is accepted; a non-multi key keeps its first value
    only. Booleans render as "true"/"false" so ``unlinked: true`` matches its
    closed value set. Anything outside a closed set is dropped, value by value.
    """
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    values = []
    for item in items:
        if isinstance(item, bool):
            item = "true" if item else "false"
        text = str(item).strip()
        if not text:
            continue
        if allowed is not None and text not in allowed:
            continue
        values.append(text)
    if not multi:
        values = values[:1]
    return values


def build_link(screen: str, params: dict) -> str | None:
    """Build an app-relative URL for a screen, or None when it cannot be built.

    Unknown screens and unknown keys are dropped without error — the model
    proposed them, and a bad proposal costs a link, not a failure. An empty id
    on a detail screen also returns None: the hydrator proved the entity
    exists, so a blank here means the model lost the id.
    """
    if not isinstance(params, dict):
        params = {}

    detail = _DETAIL_SCREENS.get(screen)
    if detail is not None:
        template, id_key = detail
        raw = params.get(id_key) if id_key in params else params.get("id")
        value = str(raw).strip() if raw is not None else ""
        if not value:
            return None
        # safe="" also encodes "/", so an id can never add path segments.
        return template.format(quote(value, safe=""))

    filtered = _FILTER_SCREENS.get(screen)
    if filtered is None:
        return None
    path, keys = filtered
    pairs = [
        f"{key}={quote(value, safe='')}"
        for key, multi, allowed in keys
        for value in _values(params.get(key), multi, allowed)
    ]
    return f"{path}?{'&'.join(pairs)}" if pairs else path
