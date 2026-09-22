"""Work orders -> Dynamic Configuration (the deployed Configuration Manager).

Every NEW or CHANGED work order the mirror learns is pushed as one JSON
configuration, against the REAL Dynamic Configuration contract
(Quix.DynamicConfiguration backend, verified 25 Aug 2026 -- the reference
estate's mock had a `replace` upsert flag the real service does not know, and
its models are extra=forbid, so that body 422s):

* create -- `POST /api/v1/configurations` `{metadata: {type, target_key},
  content}`; the service answers 409 when the (type, target_key) pair exists;
* update -- `PUT /api/v1/configurations/{id}` `{content}`, where the id is
  the service's own deterministic `sha1("{type}-{target_key}")`, so no lookup
  round-trip is needed; a content update bumps the version.

Best-effort BY CONTRACT: the planning sync must never fail, block long, or
lose a mirror write because the config API is away -- a missed push heals on
the next change of that work order. Ours (overlay), until upstream carries a
work-order push of its own.
"""

import hashlib
import logging
import os

import httpx

log = logging.getLogger("api.config_push")

# The configuration type Dynamic Configuration files these under.
CONFIG_TYPE = "WorkOrder"


def _base_url() -> str:
    """The deployed Configuration Manager; empty disables the push."""
    return os.environ.get("CONFIG_API_URL", "").strip().rstrip("/")


def push_work_orders(rows: list[dict]) -> list[str]:
    """Push each work order as one JSON configuration, best-effort.

    `rows` are planning's verbatim payloads (the mirror's `raw`), so the
    configuration content is exactly what planning stated -- id, title,
    project, status and whatever else rode along. `target_key` is the work
    order id: the first push creates the configuration, and a change PUTs a
    new content version onto the same one.

    Returns the ids that LANDED (2xx) -- the caller stamps exactly those, so
    a refused or unreachable push is retried on the next pass rather than
    waiting for the work order's next change (25 Aug 2026).
    """
    base = _base_url()
    if not base or not rows:
        return []

    headers = {}
    token = os.environ.get("Quix__Sdk__Token", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    pushed: list[str] = []
    with httpx.Client(base_url=base, headers=headers, timeout=10.0) as client:
        for row in rows:
            # Per row, not per batch: a transport error (timeout, connect) on
            # one work order used to abort the loop, and with a stable
            # catalog order the SAME row starved every row behind it on
            # every pass (found 25 Aug 2026).
            try:
                response = client.post(
                    "/api/v1/configurations",
                    json={
                        "metadata": {"type": CONFIG_TYPE, "target_key": row["id"]},
                        "content": row,
                    },
                )
                if response.status_code == 409:
                    # The pair exists -- a change becomes a new content
                    # version on the same configuration. The id is the
                    # service's own deterministic derivation, so no lookup.
                    config_id = hashlib.sha1(
                        f"{CONFIG_TYPE}-{row['id']}".encode()
                    ).hexdigest()
                    response = client.put(
                        f"/api/v1/configurations/{config_id}",
                        json={"content": row},
                    )
            except httpx.HTTPError as error:
                log.warning("config push failed for %s: %s", row["id"], error)
                continue
            if response.status_code >= 400:
                log.warning(
                    "config push refused for %s: %s %s",
                    row["id"],
                    response.status_code,
                    response.text[:200],
                )
            else:
                pushed.append(row["id"])
                log.info(
                    "work order %s pushed to Dynamic Configuration", row["id"]
                )
    return pushed
