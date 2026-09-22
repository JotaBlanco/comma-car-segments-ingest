"""Puts ``battery-trace-gen`` on ``sys.path`` so ``plant.loader`` imports."""

import sys
from pathlib import Path

BATTERY_TRACE_GEN_DIR = Path(__file__).resolve().parents[2]
if str(BATTERY_TRACE_GEN_DIR) not in sys.path:
    sys.path.insert(0, str(BATTERY_TRACE_GEN_DIR))
