"""Identity of the generator and of the plant it vendors.

The same strings go into every MF4 header and into ``out/manifest.json``; the prose
version lives in ``PLANT_ORIGIN``.
"""

TOOL_NAME = "battery-trace-gen"
TOOL_VERSION = "0.1.0"

PLANT_REPO = "quixstreams-tests"
PLANT_REF = "cae68bd710a247d7fbbd7174bebdcfd593219315"
PLANT_PATH = "dc-battery-sim"
PLANT_PATCH = "current-sign conversion to battery perspective, 3 statements"

SIGN_CONVENTION = "battery: I > 0 = discharge, I < 0 = charge"
