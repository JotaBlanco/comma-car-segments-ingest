"""Battery Sim UI - polls the plant's telemetry topic and drives it from a browser.

Flask/waitress serve the page and a polling API; QuixStreams handles both Kafka
directions. Mirrors the uiservice template shape: a background consumer thread
via `sdf.update()` keeps `latest` current, Flask/waitress runs on a daemon
thread, and `consumer_app.run()` stays on the main thread so SIGTERM is caught
correctly. See docs/architecture-battery-sim-ui.md for the control-law and
sign-convention rationale.
"""

import os
import threading

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from quixstreams import Application
from waitress import serve

from page import PAGE_HTML
from setup_logging import get_logger

load_dotenv()
logger = get_logger()

input_topic_name = os.environ["input"]
output_topic_name = os.environ["output"]
consumer_group = os.getenv("Quix__Deployment__Id", "battery-sim-ui")

# Pedal/charge power ceilings - named constants, overridable per deployment
# without a rebuild (app.yaml FreeText vars). See spec sec 2c/3c.
PEDAL_DISCHARGE_MAX_W = float(os.getenv("PEDAL_DISCHARGE_MAX_W", "60000"))
PEDAL_CHARGE_REGEN_MAX_W = float(os.getenv("PEDAL_CHARGE_REGEN_MAX_W", "20000"))
DC_CHARGE_MAX_W = float(os.getenv("DC_CHARGE_MAX_W", "250000"))

# The plant's DERATING_LUT (battery-trace-gen/plant/main.py) is fixed and not
# exposed on any topic, so its breakpoints are mirrored here for chart shading.
DERATE_BAND_START_C = 50.0
DERATE_HARD_LIMIT_C = 60.0

latest = {}
latest_lock = threading.Lock()

consumer_app = Application(consumer_group=consumer_group)
input_topic = consumer_app.topic(input_topic_name)

producer_app = Application(consumer_group=f"{consumer_group}-prod")
output_topic = producer_app.topic(output_topic_name)
producer = producer_app.get_producer()

flask_app = Flask(__name__)
CORS(flask_app)


def requested_power_w(accel_pct, brake_pct, charge_plug, charge_rate_w):
    """Powertrain-sign watts for the plant's `requested_power_w` signal.

    Charging (plug in) is a third mode: pedals are ignored, the charge slider
    commands positive power directly up to DC_CHARGE_MAX_W. Off the plug,
    net_pct = accel - brake drives discharge (negative W, up to
    PEDAL_DISCHARGE_MAX_W) or regen (positive W, up to
    PEDAL_CHARGE_REGEN_MAX_W) - the plant's power/current sign flip
    (PLANT_ORIGIN) is crossed once, here.
    """
    if charge_plug:
        return max(0.0, min(DC_CHARGE_MAX_W, charge_rate_w))
    net_pct = max(-100.0, min(100.0, accel_pct - brake_pct))
    if net_pct >= 0:
        return -net_pct / 100.0 * PEDAL_DISCHARGE_MAX_W
    return -net_pct / 100.0 * PEDAL_CHARGE_REGEN_MAX_W


@flask_app.route("/")
def index():
    return PAGE_HTML, 200, {"Content-Type": "text/html; charset=utf-8"}


@flask_app.route("/config")
def config_route():
    return jsonify(
        {
            "pedal_discharge_max_w": PEDAL_DISCHARGE_MAX_W,
            "pedal_charge_regen_max_w": PEDAL_CHARGE_REGEN_MAX_W,
            "dc_charge_max_w": DC_CHARGE_MAX_W,
            "derate_band_start_c": DERATE_BAND_START_C,
            "derate_hard_limit_c": DERATE_HARD_LIMIT_C,
        }
    )


@flask_app.route("/battery/data")
def battery_data_route():
    with latest_lock:
        return jsonify(dict(latest))


@flask_app.route("/command", methods=["POST"])
def command_route():
    data = request.json
    if not data:
        return Response(status=400)
    power_w = requested_power_w(
        float(data.get("accel_pct", 0)),
        float(data.get("brake_pct", 0)),
        bool(data.get("charge_plug", False)),
        float(data.get("charge_rate_w", 0)),
    )
    signals = {
        "requested_power_w": power_w,
        "ambient_temp_c": float(data.get("ambient_temp_c", 15)),
        "chiller_setting": int(data.get("chiller_setting", 0)),
        "heater_setting": int(data.get("heater_setting", 0)),
    }
    msg = output_topic.serialize(key="ui-command", value={"signals": signals})
    producer.produce(output_topic.name, value=msg.value, key=msg.key)
    return Response(status=200)


if __name__ == "__main__":
    logger.info(
        "[STARTUP] battery-sim-ui: input=%s output=%s pedal_discharge_max_w=%s "
        "pedal_charge_regen_max_w=%s dc_charge_max_w=%s",
        input_topic_name,
        output_topic_name,
        PEDAL_DISCHARGE_MAX_W,
        PEDAL_CHARGE_REGEN_MAX_W,
        DC_CHARGE_MAX_W,
    )

    # Flask runs in a daemon thread; QuixStreams consumer runs in main thread
    # so signal handlers (SIGTERM) are registered correctly.
    threading.Thread(
        target=lambda: serve(flask_app, host="0.0.0.0", port=80),
        daemon=True,
    ).start()

    sdf = consumer_app.dataframe(input_topic)

    def update_latest(value):
        with latest_lock:
            latest.update(value)

    sdf = sdf.update(update_latest)
    consumer_app.run(sdf)
