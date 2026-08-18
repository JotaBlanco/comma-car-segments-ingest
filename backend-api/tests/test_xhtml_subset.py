"""Amended N1: what the accepted XHTML subset flattens to, and what it refuses.

Round-1 blocker: spec N1 permits ``<xhtml:br/>`` and nothing else inside the
``<xhtml:div>``, while every ``text`` and ``rationale`` value in the real ReqIF
export wraps its content in ``<xhtml:p>`` - so the acceptance fixture named by the
spec was rejected with 74 ``xhtml_shape`` problems. The parser was relaxed to a
constrained subset; these tests pin both halves of that decision, the accepting
half and the still-refusing half.
"""

from xml.etree import ElementTree

import pytest

import reqif_parser
import xhtml_text
from validation import UploadRejected

XHTML_NS = 'xmlns:xhtml="http://www.w3.org/1999/xhtml"'


def the_value(inner: str):
    return ElementTree.fromstring(f"<THE-VALUE {XHTML_NS}>{inner}</THE-VALUE>")


def flatten(inner: str) -> str:
    return xhtml_text.flatten_the_value(the_value(inner))


# --- the accepted subset -----------------------------------------------------


def test_a_single_paragraph_unwraps_to_its_text_exactly():
    """The property the whole convergence proof rests on: 1:1, no decoration."""
    text = "The ACC system shall enter the Standby state."
    assert flatten(f"<xhtml:div><xhtml:p>{text}</xhtml:p></xhtml:div>") == text


def test_the_exporters_indentation_is_not_part_of_the_value():
    inner = "<xhtml:div>\n    <xhtml:p>Indented prose.</xhtml:p>\n  </xhtml:div>"
    assert flatten(inner) == "Indented prose."


def test_multiple_paragraphs_join_with_a_blank_line():
    inner = "<xhtml:div><xhtml:p>One.</xhtml:p><xhtml:p>Two.</xhtml:p></xhtml:div>"
    assert flatten(inner) == "One.\n\nTwo."


def test_br_inside_a_paragraph_becomes_a_newline():
    inner = "<xhtml:div><xhtml:p>a<xhtml:br/>b</xhtml:p></xhtml:div>"
    assert flatten(inner) == "a\nb"


def test_br_directly_under_the_div_still_works_as_the_original_rule_said():
    inner = "<xhtml:div>a<xhtml:br/>b</xhtml:div>"
    assert flatten(inner) == "a\nb"


@pytest.mark.parametrize("element", ["em", "strong", "code"])
def test_inline_emphasis_contributes_its_text_and_nothing_else(element):
    inner = (
        f"<xhtml:div><xhtml:p>a <xhtml:{element}>b</xhtml:{element}> c</xhtml:p></xhtml:div>"
    )
    assert flatten(inner) == "a b c"


def test_a_value_with_no_markup_at_all_is_returned_as_is():
    assert flatten("plain text") == "plain text"


def test_an_absent_value_is_the_empty_string():
    assert xhtml_text.flatten_the_value(None) == ""


# --- what stays a rejection --------------------------------------------------


@pytest.mark.parametrize(
    ("inner", "element"),
    [
        ("<xhtml:div><xhtml:ul><xhtml:li>x</xhtml:li></xhtml:ul></xhtml:div>", "ul"),
        ("<xhtml:div><xhtml:table><xhtml:tr/></xhtml:table></xhtml:div>", "table"),
        ("<xhtml:div><xhtml:div>nested</xhtml:div></xhtml:div>", "div"),
        ('<xhtml:div><xhtml:a href="x">link</xhtml:a></xhtml:div>', "a"),
        ('<xhtml:div><xhtml:img src="x"/></xhtml:div>', "img"),
        ("<xhtml:div><xhtml:p><xhtml:p>nested</xhtml:p></xhtml:p></xhtml:div>", "p"),
        ("<xhtml:div><xhtml:p><xhtml:ul><xhtml:li/></xhtml:ul></xhtml:p></xhtml:div>", "ul"),
    ],
)
def test_structural_markup_is_refused_and_names_the_element(inner, element):
    with pytest.raises(xhtml_text.XhtmlSubsetError) as raised:
        flatten(inner)
    assert raised.value.element == element
    assert f"<{element}>" in str(raised.value)
    assert "accepted:" in str(raised.value)


def test_the_wrong_container_shape_is_still_refused():
    with pytest.raises(xhtml_text.XhtmlSubsetError):
        flatten("<xhtml:p>no div at all</xhtml:p>")
    with pytest.raises(xhtml_text.XhtmlSubsetError):
        flatten("<xhtml:div>one</xhtml:div><xhtml:div>two</xhtml:div>")


# --- through the parser, where it becomes a reason code ----------------------


def _one_object_reqif(text_body: str) -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<REQ-IF {XHTML_NS}>
  <CORE-CONTENT><REQ-IF-CONTENT><SPEC-OBJECTS>
    <SPEC-OBJECT IDENTIFIER="_1">
      <VALUES>
        <ATTRIBUTE-VALUE-STRING THE-VALUE="ACC-SYS-FUN-001">
          <DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>AD-ID</ATTRIBUTE-DEFINITION-STRING-REF>
          </DEFINITION>
        </ATTRIBUTE-VALUE-STRING>
        <ATTRIBUTE-VALUE-XHTML>
          <DEFINITION><ATTRIBUTE-DEFINITION-XHTML-REF>AD-TEXT</ATTRIBUTE-DEFINITION-XHTML-REF>
          </DEFINITION>
          <THE-VALUE>{text_body}</THE-VALUE>
        </ATTRIBUTE-VALUE-XHTML>
      </VALUES>
    </SPEC-OBJECT>
  </SPEC-OBJECTS></REQ-IF-CONTENT></CORE-CONTENT>
</REQ-IF>""".encode()


def test_out_of_subset_xhtml_rejects_the_upload_with_the_xhtml_shape_code():
    body = "<xhtml:div><xhtml:table><xhtml:tr/></xhtml:table></xhtml:div>"
    with pytest.raises(UploadRejected) as raised:
        reqif_parser.parse_reqif(_one_object_reqif(body))
    problems = raised.value.problems
    assert raised.value.stage == "reqif_mapping"
    assert [problem.code for problem in problems] == ["xhtml_shape"]
    assert problems[0].pointer == "/text"
    assert problems[0].entity_id == "_1"
    assert "<table>" in problems[0].message


def test_a_paragraph_wrapped_value_is_no_longer_a_problem():
    """The exact shape that produced 74 problems in round 1."""
    body = "<xhtml:div><xhtml:p>Wrapped in a paragraph.</xhtml:p></xhtml:div>"
    items, _, _ = reqif_parser.parse_reqif(_one_object_reqif(body))
    assert [item["text"] for item in items] == ["Wrapped in a paragraph."]
