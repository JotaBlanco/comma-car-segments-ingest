"""tm-connector entry point. Wiring only — every decision lives in `connector/`.

The consumer group is a hard-coded constant, exactly as the decoder's is
(mf4-decoder/main.py:68-83). Keeping it out of app.yaml means the Portal cannot
rotate it, and a rotated group is a full topic replay: harmless here — run
upserts merge, file registers dedup on the checksum, journals are 201-gated —
but wasted work all the same.
"""

import logging
import os

from quixstreams import Application

from connector.config import Config
from connector.connector import Connector
from connector.registry import Registry
from connector.status import serve_status

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("tm-connector.main")

# v2 (14 Sep 2026): the registry moved into the Configuration Manager's Mongo, so everything
# registered before that lives in a database nobody reads. A new group replays both topics from
# the start into the new one; every write is idempotent (see above).
CONSUMER_GROUP = "tm-connector-v2"


def build(config: Config | None = None) -> tuple[Application, Connector]:
    """Build the topology. Returns the app and the connector driving it."""
    config = config or Config.from_env()
    registry = Registry(
        base_url=config.api_url,
        token=config.api_token,
        timeout=config.http_timeout_seconds,
        max_backoff=config.retry_max_backoff_seconds,
        max_attempts=config.retry_max_attempts,
    )
    connector = Connector(registry, config)

    app = Application(consumer_group=CONSUMER_GROUP, auto_offset_reset="earliest")

    # Two inputs, no output. The metadata lane registers the run the moment the
    # upload lands; the batch lane owns the file, its inventory and its timeline.
    metadata_topic = app.topic(
        os.environ["metadata_input"], value_deserializer="json", key_deserializer="str"
    )
    app.dataframe(topic=metadata_topic).update(connector.on_metadata)

    batch_topic = app.topic(
        os.environ["batch_input"], value_deserializer="json", key_deserializer="str"
    )
    app.dataframe(topic=batch_topic).update(connector.on_batch)

    return app, connector


def run() -> None:
    config = Config.from_env()
    app, connector = build(config)
    serve_status(connector.status_snapshot, config.status_port)
    log.info(
        "tm-connector starting — registry %s, group %s, inputs %s + %s",
        config.api_url,
        CONSUMER_GROUP,
        os.environ.get("metadata_input"),
        os.environ.get("batch_input"),
    )
    app.run()


if __name__ == "__main__":
    run()
