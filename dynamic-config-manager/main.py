from dotenv import load_dotenv

load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging  # noqa: E402
import os  # noqa: E402

import requests  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field, model_validator  # noqa: E402
from quixstreams import Application  # noqa: E402

from transform import build_config_event  # noqa: E402

logging.basicConfig(level=os.environ.get("LOGLEVEL", "INFO"))
logger = logging.getLogger(__name__)

api = FastAPI(
    title="Dynamic Config Manager",
    version="1.0.0",
    description=(
        "Publishes parameter sets as Quix Dynamic Configuration events on the config-events "
        "topic. The read path is the Test Manager API's /parameter-sets, backed by the "
        "parameter_sets collection that mongo-writer fills from this topic - there is no "
        "in-memory config slot any more, because a run has to pin a specific "
        "(config_id, config_version) and a volatile last-write-wins slot cannot serve that."
    ),
)

_app: Application | None = None
_topic = None


def _output_topic_name() -> str:
    return os.environ.get("output") or "config-events"


def _bus():
    """Build the Application lazily so importing this module needs no broker."""
    global _app, _topic
    if _app is None:
        _app = Application(consumer_group="dynamic-config-manager")
        _topic = _app.topic(
            _output_topic_name(), value_serializer="json", key_serializer="string"
        )
    return _app, _topic


class ConfigPost(BaseModel):
    """A parameter set to publish. ``extra="forbid"`` so a typo is a 422."""

    model_config = ConfigDict(extra="forbid")

    config_id: str = Field(pattern=r"^CFG-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    params: dict
    config_version: int | None = Field(default=None, ge=1)
    target_key: str | None = None
    category: str = "plant-config"
    content_url: str | None = None
    valid_from: str | None = None

    @model_validator(mode="after")
    def _params_not_empty(self):
        if not self.params:
            raise ValueError("params must contain at least one parameter")
        return self


def next_version(config_id: str) -> int:
    """Mint a monotonic version by asking the registry what already exists.

    Versions have to be monotonic per ``config_id`` and this service holds no
    state, so the single registry is the only honest source. If it is unreachable
    the request fails rather than guessing 1 and overwriting v1.
    """
    base = (os.environ.get("BACKEND_API_URL") or "http://backend-api").rstrip("/")
    try:
        response = requests.get(f"{base}/parameter-sets?config_id={config_id}", timeout=15)
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                f"cannot mint a version for {config_id}: the parameter-set registry at {base} "
                f"is unreachable ({exc}). Supply config_version explicitly to publish anyway."
            ),
        ) from exc
    versions = [
        int(item["config_version"])
        for item in payload.get("items") or []
        if item.get("config_version") is not None
    ]
    return (max(versions) + 1) if versions else 1


def publish_config_event(key: str, value: dict, producer, topic) -> dict:
    """Serialize and produce. Split out so it is testable with a fake producer."""
    message = topic.serialize(key=key, value=value)
    producer.produce(topic=topic.name, key=message.key, value=message.value)
    return value


@api.post("/config", status_code=202)
def post_config(body: ConfigPost) -> dict:
    version = body.config_version or next_version(body.config_id)
    key, value = build_config_event(
        config_id=body.config_id,
        config_version=version,
        params=body.params,
        target_key=body.target_key,
        category=body.category,
        content_url=body.content_url,
        valid_from=body.valid_from,
    )
    app, topic = _bus()
    with app.get_producer() as producer:
        publish_config_event(key, value, producer, topic)
    logger.info("Published %s@v%d (%s)", body.config_id, version, value["config_hash12"])
    return {
        "status": "accepted",
        "topic": _output_topic_name(),
        "key": key,
        "event_id": value["id"],
        "config_id": body.config_id,
        "config_version": version,
        "config_hash12": value["config_hash12"],
        "canonical_sha256": value["canonical_sha256"],
        "read_path": "/parameter-sets on the Test Manager API",
    }


@api.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "output_topic": _output_topic_name(),
        "registry": (os.environ.get("BACKEND_API_URL") or "http://backend-api"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(api, host="0.0.0.0", port=80)
