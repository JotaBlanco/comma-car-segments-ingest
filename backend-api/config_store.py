"""Thread-safe in-memory store for the latest config received from the
config-updates topic."""
import threading


class ConfigStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._current: dict | None = None

    def update(self, config: dict) -> None:
        with self._lock:
            self._current = config

    def get(self) -> dict | None:
        with self._lock:
            return self._current


def handle_config_message(value: dict, store: ConfigStore) -> None:
    """Apply an incoming config-updates message to the store. Kept as a
    standalone function so it is trivially unit testable."""
    store.update(value)
