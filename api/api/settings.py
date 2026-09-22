"""Settings from environment variables. No value is ever hard-coded."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    mongo_url: str
    planning_api_url: str
    api_token: str | None


def get_settings() -> Settings:
    """Read the settings at call time, so tests can change the environment."""
    return Settings(
        mongo_url=os.environ.get("MONGO_URL", "mongodb://localhost:27017"),
        planning_api_url=os.environ.get("PLANNING_API_URL", "http://localhost:8003"),
        api_token=os.environ.get("TM_API_TOKEN") or None,
    )
