"""Amended N1: flatten a constrained XHTML subset to plain text.

Deliberate deviation from spec 1.1.1 N1, which permits ``<xhtml:br/>`` as the
*only* nested element inside the ``<xhtml:div>`` of an
``ATTRIBUTE-VALUE-XHTML``. That rule cannot parse the acceptance fixture the
spec itself names (``Reqs/export/acc-system-requirements.reqif``): every
``AD-TEXT`` and ``AD-RATIONALE`` value in that export - and in the output of
every ReqIF authoring tool the author is aware of - wraps its content in
``<xhtml:p>``. The exporter is validated against the vendored ReqIF XSD and
round-trips attribute by attribute, so the consumer is what gets relaxed.
See ``dev-planning/test-manager-backend-architecture.md`` section 8, departure 13.

**The accepted subset, and nothing else:**

* one ``<xhtml:div>`` as the sole child of ``THE-VALUE`` (unchanged from N1);
* ``<xhtml:p>`` - a block. Zero or more, at div level only;
* ``<xhtml:br/>`` - a hard line break, at div level or inside a block;
* ``<xhtml:em>``, ``<xhtml:strong>``, ``<xhtml:code>`` - inline, unwrapped to
  their text content. Presentational only, and the canonical field is a plain
  string; the original ``.reqif`` is retained under ``source/`` so the audit
  trail keeps the markup.

Anything else - ``ul``, ``li``, ``table``, ``tr``, ``td``, ``object``, ``a``,
``img``, a nested ``div`` - raises :class:`XhtmlSubsetError` and the caller
rejects the upload with reason code ``xhtml_shape``. Relaxing N1 must not become
"accept arbitrary markup": flattening a table to running text changes its
meaning, so it stays a rejection rather than a silent strip.

**The flattening, which is deterministic and must stay so:**

1. a run of bare text and ``<br/>`` at div level forms one implicit block;
2. each ``<xhtml:p>`` forms one block;
3. inside a block, ``<br/>`` becomes ``\\n`` and inline elements contribute
   their flattened text content;
4. each block is stripped of leading and trailing whitespace, and empty blocks
   are dropped (this is what discards the exporter's indentation);
5. blocks are joined with ``\\n\\n``.

A single ``<xhtml:p>`` therefore unwraps to its text content *exactly*, which is
the property the ReqIF/JSON convergence proof (spec 1.1.2) depends on: for all
37 requirements of the real export, the flattened value is byte-identical to the
string the JSON upload path carries.

N2-N4 (entity unescaping, NFC, whitespace collapse, punctuation untouched) are
**not** applied here; the caller pipes the result through
``canonical.normalise_text`` so both upload paths run one implementation of
those rules. This module therefore imports nothing from the project and is a
pure function of the parsed XML.
"""

# Block-level: starts a new paragraph.
BLOCK_ELEMENTS = frozenset({"p"})
# Inline: contributes text to the block it appears in.
INLINE_ELEMENTS = frozenset({"br", "em", "strong", "code"})
ACCEPTED_ELEMENTS = BLOCK_ELEMENTS | INLINE_ELEMENTS

_ACCEPTED_TEXT = "<xhtml:p>, <xhtml:br/>, <xhtml:em>, <xhtml:strong>, <xhtml:code>"


class XhtmlSubsetError(ValueError):
    """The value uses XHTML outside the accepted subset, or the wrong shape.

    Carries ``element`` (the offending local element name, or ``None`` when the
    problem is the ``THE-VALUE``/``div`` shape itself) so a caller can build a
    machine-readable problem without re-parsing the message.
    """

    def __init__(self, message: str, element: str | None = None) -> None:
        self.element = element
        super().__init__(message)


def local_name(tag: str) -> str:
    """Local name of a possibly namespaced tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def flatten_the_value(the_value) -> str:
    """Flatten one ``THE-VALUE`` element to text. Raises :class:`XhtmlSubsetError`.

    ``the_value`` may be ``None`` (absent attribute value), which yields ``""``
    so N5's "absent optional string becomes empty string" stays the caller's
    rule rather than a special case here.
    """
    if the_value is None:
        return ""
    elements = list(the_value)
    if not elements:
        # A plain-text XHTML value with no markup at all.
        return the_value.text or ""
    if len(elements) != 1 or local_name(elements[0].tag) != "div":
        found = [local_name(element.tag) for element in elements]
        raise XhtmlSubsetError(
            "THE-VALUE must contain exactly one <xhtml:div>, found " + repr(found),
            element=found[0] if len(found) == 1 else None,
        )
    return _flatten_div(elements[0])


def _flatten_div(div) -> str:
    """Rules 1-5 of the docstring, over the children of the single div."""
    blocks: list[str] = []
    implicit: list[str] = []

    if div.text:
        implicit.append(div.text)

    for child in div:
        name = local_name(child.tag)
        if name in BLOCK_ELEMENTS:
            blocks.append("".join(implicit))
            implicit = []
            blocks.append(_flatten_inline(child))
        elif name in INLINE_ELEMENTS:
            implicit.append(_flatten_inline_here(child))
        else:
            raise XhtmlSubsetError(_rejection(name), element=name)
        if child.tail:
            implicit.append(child.tail)

    blocks.append("".join(implicit))
    return "\n\n".join(block.strip() for block in blocks if block.strip())


def _flatten_inline(node) -> str:
    """Text content of a block or inline element, with ``<br/>`` as a newline."""
    parts: list[str] = []
    if node.text:
        parts.append(node.text)
    for child in node:
        name = local_name(child.tag)
        if name not in INLINE_ELEMENTS:
            # A <p> inside a <p>, or any structural element: not in the subset.
            raise XhtmlSubsetError(_rejection(name), element=name)
        parts.append(_flatten_inline_here(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def _flatten_inline_here(node) -> str:
    """One inline element: ``<br/>`` is a newline, the rest unwrap recursively."""
    if local_name(node.tag) == "br":
        # An <xhtml:br/> with children is not <br/>; treat it as its own text.
        return "\n" + _flatten_inline(node)
    return _flatten_inline(node)


def _rejection(name: str) -> str:
    return (
        f"<{name}> is not in the accepted XHTML subset for a canonical text attribute; "
        f"accepted: {_ACCEPTED_TEXT} (amended N1). Structural markup is rejected rather "
        f"than silently flattened, because flattening it would change its meaning."
    )
