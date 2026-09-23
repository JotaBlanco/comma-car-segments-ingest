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
# without a rebuild (app.yaml FreeText vars). Discharge matches the charge
# slider at the lexicon's 250 kW limit for requested_power_w; regen stays lower
# because a real regen path is limited by the motor, not the pack.
PEDAL_DISCHARGE_MAX_W = float(os.getenv("PEDAL_DISCHARGE_MAX_W", "352000"))
PEDAL_CHARGE_REGEN_MAX_W = float(os.getenv("PEDAL_CHARGE_REGEN_MAX_W", "80000"))
DC_CHARGE_MAX_W = float(os.getenv("DC_CHARGE_MAX_W", "250000"))

# The plant's DERATING_LUT (battery-trace-gen/plant/main.py) is fixed and not
# exposed on any topic, so its breakpoints are mirrored here for chart shading.
DERATE_BAND_START_C = 50.0
DERATE_HARD_LIMIT_C = 60.0

# Road load is a second-order polynomial in road speed:
#     F_resist = K_ROLL_N + K_LIN_N_PER_MPS * v + K_DRAG_N_PER_MPS2 * v^2
# The three coefficients and V_FLOOR_MPS are solved together against two stated
# targets - 320 km/h top speed and 0-100 km/h in 3.0 s - with the launch capped
# at 1.3 g, which is what sets the power: 0-100 in 3 s is an energy budget
# (0.5 * m * v^2 = 772 kJ in 3 s), so no choice of drag makes 250 kW reach it.
#
# Vehicle display constants for the car visualisation. The plant is a pack
# model and publishes no road speed, so the browser integrates one from the
# achieved pack power and from the friction brake the pedal adds past half
# travel - a mechanical force no plant signal carries (see page_vehicle.py).
# None of these has provenance in this repository - they are display constants
# in the same sense as the pedal ceilings above, served on /config and
# overridable per deployment.
VEHICLE_MASS_KG = float(os.getenv("VEHICLE_MASS_KG", "2000"))  # kg
K_DRAG_N_PER_MPS2 = float(os.getenv("K_DRAG_N_PER_MPS2", "0.3692"))  # N/(m/s)^2
K_ROLL_N = float(os.getenv("K_ROLL_N", "200"))  # N
K_LIN_N_PER_MPS = float(os.getenv("K_LIN_N_PER_MPS", "5.0"))  # N/(m/s)
DRIVELINE_EFF = float(os.getenv("DRIVELINE_EFF", "0.90"))  # dimensionless
V_FLOOR_MPS = float(os.getenv("V_FLOOR_MPS", "12.41"))  # m/s
WHEEL_RADIUS_M = float(os.getenv("WHEEL_RADIUS_M", "0.34"))  # m
F_BRAKE_MAX_N = float(os.getenv("F_BRAKE_MAX_N", "14700"))  # N at 100 % brake pedal

# The plant's TIME_SCALE lexicon range. The slider's ends are exactly these,
# so no value it can emit is out of range and the knob never snaps back.
TIME_SCALE_MIN = 1.0
TIME_SCALE_MAX = 50.0

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
            "vehicle_mass_kg": VEHICLE_MASS_KG,
            "k_drag_n_per_mps2": K_DRAG_N_PER_MPS2,
            "k_roll_n": K_ROLL_N,
            "k_lin_n_per_mps": K_LIN_N_PER_MPS,
            "driveline_eff": DRIVELINE_EFF,
            "v_floor_mps": V_FLOOR_MPS,
            "wheel_radius_m": WHEEL_RADIUS_M,
            "f_brake_max_n": F_BRAKE_MAX_N,
            "time_scale_min": TIME_SCALE_MIN,
            "time_scale_max": TIME_SCALE_MAX,
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
        # Momentary: the plant restores its state on the tick that sees a 1 and
        # clears the flag itself, so the page never has to send a 0 back.
        "reset": int(data.get("reset", 0)),
    }
    # TIME_SCALE is a plant PARAMETER, not a signal: the plant divides its
    # inter-tick sleep by it and nothing else. handle_command applies the two
    # objects independently.
    parameters = {"TIME_SCALE": float(data["time_scale"])}
    msg = output_topic.serialize(
        key="ui-command", value={"signals": signals, "parameters": parameters}
    )
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
