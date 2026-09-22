"""A tiny status endpoint, served from a daemon thread.

The Kafka consumer runs in the main thread. `http.server` costs no dependency
and no event loop, and the endpoint is read-only, so a thread is the whole
design. The Test Bench surfaces `/status`.
"""

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

log = logging.getLogger("tm-connector.status")


def build_handler(snapshot: Callable[[], dict]) -> type[BaseHTTPRequestHandler]:
    class StatusHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _write(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's name
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path in ("/", "/health"):
                self._write(200, {"ok": True, "service": "tm-connector"})
                return
            if path == "/status":
                self._write(200, snapshot())
                return
            self._write(404, {"error": "not found", "path": path})

        def log_message(self, fmt: str, *args) -> None:
            # The default handler writes to stderr on every request, which turns
            # a liveness probe into a log flood.
            log.debug(fmt, *args)

    return StatusHandler


def serve_status(snapshot: Callable[[], dict], port: int) -> ThreadingHTTPServer:
    """Start the status server on a daemon thread and return it."""
    server = ThreadingHTTPServer(("0.0.0.0", port), build_handler(snapshot))
    thread = threading.Thread(target=server.serve_forever, name="tm-connector-status", daemon=True)
    thread.start()
    log.info("status endpoint listening on :%d/status", port)
    return server
