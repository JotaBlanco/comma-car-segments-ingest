from transform import build_config_event


def test_build_config_event_uses_config_id_as_key():
    payload = {"config_id": "abc-123", "setting": "value"}
    key, value = build_config_event(payload, event_id="evt-1", received_at="2026-01-01T00:00:00+00:00")

    assert key == "abc-123"
    assert value["config_id"] == "abc-123"
    assert value["setting"] == "value"
    assert value["event_id"] == "evt-1"
    assert value["received_at"] == "2026-01-01T00:00:00+00:00"


def test_build_config_event_falls_back_to_id_field():
    payload = {"id": "id-456"}
    key, value = build_config_event(payload)

    assert key == "id-456"


def test_build_config_event_generates_key_when_missing():
    payload = {"setting": "value"}
    key, value = build_config_event(payload)

    assert isinstance(key, str) and len(key) > 0
    assert "event_id" in value
    assert "received_at" in value
