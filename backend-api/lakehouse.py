"""Wrapper around the Quix Lakehouse Query REST API. Guarded so the app
keeps running (with this feature disabled) when Lakehouse is not bound to
the deployment."""
import logging
import os

import requests

logger = logging.getLogger(__name__)


def is_available() -> bool:
    return bool(os.environ.get("Quix__Lakehouse__Query__Url")) and bool(
        os.environ.get("Quix__Lakehouse__Query__AuthToken")
    )


def query_lakehouse(sql: str) -> dict | None:
    url = os.environ.get("Quix__Lakehouse__Query__Url")
    token = os.environ.get("Quix__Lakehouse__Query__AuthToken")
    if not url or not token:
        logger.warning("Lakehouse query env vars are not set; lakehouse queries are disabled")
        return None
    try:
        resp = requests.post(
            f"{url.rstrip('/')}/query",
            data=sql,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        logger.warning("Lakehouse query failed: %s", exc)
        return None
