"""The HTTP client for the Test Manager API. No database, no blob store.

Fault classification splits on WHO is at fault, because one blanket rule is
wrong in both directions:

* **5xx / 429 / connection error / timeout** — the registry is down and our
  message is fine. Retry with exponential backoff, and if the bounded attempts
  are spent raise `RegistryUnavailable`. The caller lets it propagate, so the
  offset is never committed and redelivery retries. Committing past a failed run
  upsert is exactly the silent permanent loss the ordering constraint forbids.
* **4xx other than 429** — our message is malformed (a 422 from
  `extra="forbid"`, a rejected `Actor`, an out-of-enum `source_system`).
  Re-sending the same bytes forever blocks the partition and can never succeed.
  Raise `RegistryRejected`; the caller logs it loudly, counts it and commits.
  Data is lost — visibly and countably, never silently.
"""

import logging
import time
from typing import Any, Callable

import httpx

log = logging.getLogger("tm-connector.registry")

# The first backoff. Each attempt doubles it, capped at the configured maximum.
BASE_BACKOFF_SECONDS = 0.5

RETRYABLE_STATUS = frozenset({429})


class RegistryUnavailable(RuntimeError):
    """The registry could not be reached within this delivery's retry budget."""


class RegistryRejected(RuntimeError):
    """The registry refused the body. Re-sending it can never succeed."""

    def __init__(self, status_code: int, path: str, detail: str) -> None:
        super().__init__(f"{path} answered {status_code}: {detail}")
        self.status_code = status_code
        self.path = path
        self.detail = detail


class Registry:
    """A thin HTTP client for the four seam routes. We use three of them.

    `POST /test-runs/{run_id}/signals` is deliberately NOT here: it mints a
    SEPARATE logical file — `filename=f"api-submission-{...}Z.json"`,
    `format="JSON"`, `source_system="api"`
    (api/api/routers/test_runs.py:199-260) — so using it for an MF4's inventory
    would create a phantom second file document per real file and inflate
    `file_count`. The inventory rides in `POST /files`'s own `signals[]`.
    """

    def __init__(
        self,
        base_url: str,
        token: str | None,
        timeout: float = 30.0,
        max_backoff: float = 60.0,
        max_attempts: int = 6,
        sleep: Callable[[float], None] = time.sleep,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # Every /api/v1 route sits behind `Depends(require_token)`
        # (api/api/main.py:52), POST /test-runs and POST /files included.
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = client or httpx.Client(
            base_url=self.base_url, headers=headers, timeout=timeout
        )
        self._max_backoff = max_backoff
        self._max_attempts = max(1, max_attempts)
        self._sleep = sleep
        self.retries_spent = 0

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Registry":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        last_detail = ""
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = self._http.post(path, json=body)
            except httpx.HTTPError as error:
                last_detail = f"{type(error).__name__}: {error}"
                response = None
            if response is not None:
                status = response.status_code
                if status < 400:
                    return response
                # 401/403 are CONFIG faults (rotated/missing token), never a
                # verdict on the body: poisoning them once silently dropped
                # every registration during a token window (25 Aug 2026).
                if status < 500 and status not in RETRYABLE_STATUS and status not in (401, 403):
                    raise RegistryRejected(status, path, response.text)
                last_detail = f"{status}: {response.text}"

            if attempt == self._max_attempts:
                break
            delay = min(self._max_backoff, BASE_BACKOFF_SECONDS * (2 ** (attempt - 1)))
            self.retries_spent += 1
            log.warning(
                "%s unavailable (%s) — attempt %d/%d, retrying in %.1fs",
                path,
                last_detail,
                attempt,
                self._max_attempts,
                delay,
            )
            self._sleep(delay)

        raise RegistryUnavailable(
            f"{path} unreachable after {self._max_attempts} attempts ({last_detail})"
        )

    def upsert_run(self, body: dict[str, Any]) -> dict[str, Any]:
        """Upsert the run. 201 creates, 200 merges (api/api/routers/test_runs.py:183-197).

        A replay writes nothing: `_retained_claims` skips a claim already
        remembered and `_unresolved_claim_events` skips a duplicate journal
        entry (queries_runs.py:143-174).
        """
        return self._post("/test-runs", body).json()

    def register_file(self, body: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Register the file. Return the stored body and whether this call minted it.

        A replay dedups on (run, checksum): `_existing_registered` returns
        the stored document with 200 for the same bytes on the same run
        (api/api/routers/files.py), backed by a unique partial index on
        `(run_id, checksum_sha256)` where `status: "registered"`
        (api/api/db.py), which also settles a parallel race. The same bytes
        declared for a different run register fresh (24 Aug 2026).
        """
        response = self._post("/files", body)
        return response.json(), response.status_code == 201

    def post_event(self, event: dict[str, Any]) -> bool:
        """Send one journal event. Return False when it did not land.

        `POST /journal` has NO dedup — `add_journal_event` inserts
        unconditionally (api/api/routers/journal.py:63-97) — which is why the
        caller only ever journals a file it just minted.

        A failure never propagates. The file is already registered, and a
        redelivery would find the checksum replay and mint nothing, so raising
        here would LOSE the timeline rather than repair it. A 404 (the file
        vanished) is that event's own fault; skip it and continue the burst.
        """
        try:
            response = self._http.post("/journal", json=event)
        except httpx.HTTPError as error:
            log.warning("journal event %s failed: %s", event.get("field"), error)
            return False
        if response.status_code >= 400:
            log.warning(
                "journal event %s refused: %s %s",
                event.get("field"),
                response.status_code,
                response.text,
            )
            return False
        return True
