"""One error envelope, everywhere.

The frontend rebuild had to carry an ``_unwrap`` that flattened three shapes:
``require_blob``'s dict nested under FastAPI's ``detail``, the top-level
``BlobUnavailableError`` dict, and door validation's ``{detail, stage,
problem_count, problems[]}``. These tests pin the single shape that replaced them,
including the codes that must not be renamed because callers already key on them.
"""

import baseline_service
import deps
import error_envelope
from validation import Problem, UploadRejected

REQUIRED_KEYS = ("error", "message")


def test_a_plain_string_detail_becomes_the_message_with_a_status_derived_code():
    body = error_envelope.from_detail(404, "trace TRC-x is not registered")
    assert body == {"error": "not_found", "message": "trace TRC-x is not registered"}


def test_a_dict_detail_keeps_its_own_code_and_is_not_nested():
    body = error_envelope.from_detail(
        503, {"error": "blob_storage_unavailable", "message": "no bind", "hint": "set it"}
    )
    assert body["error"] == "blob_storage_unavailable"
    assert body["message"] == "no bind"
    assert body["hint"] == "set it"
    assert "detail" not in body


def test_a_list_detail_becomes_problems():
    body = error_envelope.from_detail(422, [{"msg": "bad"}, {"msg": "worse"}])
    assert body["error"] == "unprocessable_entity"
    assert len(body["problems"]) == 2


def test_every_status_yields_a_non_empty_code_and_message():
    for status in (400, 404, 409, 413, 422, 500, 503, 418):
        body = error_envelope.from_detail(status, None)
        for key in REQUIRED_KEYS:
            assert body[key], f"{status} produced an empty {key}"


def test_require_blob_still_uses_the_code_the_frontend_keys_on():
    """Renaming this code would break the client and the round-1 verification."""
    detail = {"error": "blob_storage_unavailable", "message": "x"}
    assert error_envelope.from_detail(503, detail)["error"] == "blob_storage_unavailable"


def test_mongo_unavailable_detail_is_the_same_envelope_shape():
    body = error_envelope.from_detail(503, deps.mongo_unavailable_detail(RuntimeError("down")))
    assert body["error"] == "mongo_unavailable"
    assert "MongoDB is unreachable" in body["message"]
    assert body["hint"]


def test_upload_rejected_leads_with_error_and_message_and_keeps_problems():
    rejection = UploadRejected(
        stage="reqif_mapping",
        problems=[Problem(code="xhtml_shape", message="text: <table>", pointer="/text")],
    )
    body = rejection.as_dict()
    assert body["error"] == "upload_rejected"
    assert "reqif_mapping" in body["message"]
    assert body["stage"] == "reqif_mapping"
    assert body["problem_count"] == 1
    assert body["problems"][0]["code"] == "xhtml_shape"
    assert body["problems"][0]["pointer"] == "/text"
    assert "detail" not in body


def test_baseline_rejected_uses_the_same_envelope():
    rejection = baseline_service.BaselineRejected(
        [{"severity": "error", "code": "unresolved_req_ref", "message": "x"}]
    )
    body = rejection.as_dict()
    assert body["error"] == "baseline_rejected"
    assert body["error_count"] == 1
    assert body["findings"][0]["severity"] == "error"
    assert "detail" not in body


def test_reserved_keys_cannot_be_overwritten_by_extras():
    body = error_envelope.envelope(500, "real message", error="real_code", detail="ignored")
    assert body["error"] == "real_code"
    assert body["message"] == "real message"
    assert "detail" not in body
