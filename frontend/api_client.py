"""Thin wrapper around the backend-api REST endpoints."""
import os

import requests

BACKEND_API_URL = os.environ.get("BACKEND_API_URL", "http://backend-api:80")


def list_items(entity_path: str) -> list[dict]:
    resp = requests.get(f"{BACKEND_API_URL}{entity_path}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def create_item(entity_path: str, item: dict) -> dict:
    resp = requests.post(f"{BACKEND_API_URL}{entity_path}", json=item, timeout=10)
    resp.raise_for_status()
    return resp.json()


def build_evaluate_params(test_run_id: str | None = None, status: str | None = None) -> dict:
    params = {}
    if test_run_id:
        params["test_run_id"] = test_run_id
    if status:
        params["status"] = status
    return params


def evaluate(test_run_id: str | None = None, status: str | None = None) -> dict:
    params = build_evaluate_params(test_run_id, status)
    resp = requests.get(f"{BACKEND_API_URL}/evaluate", params=params, timeout=10)
    resp.raise_for_status()
    return resp.json()
