import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config_store import ConfigStore, handle_config_message


def test_handle_config_message_stores_latest_value():
    store = ConfigStore()
    assert store.get() is None

    handle_config_message({"event_id": "evt-1", "threshold": 5}, store)

    assert store.get() == {"event_id": "evt-1", "threshold": 5}


def test_handle_config_message_overwrites_previous_value():
    store = ConfigStore()
    handle_config_message({"event_id": "evt-1", "threshold": 5}, store)
    handle_config_message({"event_id": "evt-2", "threshold": 10}, store)

    current = store.get()
    assert current["event_id"] == "evt-2"
    assert current["threshold"] == 10
