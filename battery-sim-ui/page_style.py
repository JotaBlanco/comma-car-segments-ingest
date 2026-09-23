"""Widget-internal CSS for the dashboard page.

Every layout and breakpoint decision belongs to Bootstrap (see page_markup.py);
this block styles component internals only - the battery, the thermometer, the
rotated pedal tracks, the knobs, the chart titles and the SVG car's fills. It
carries no @media rule: anything that would need one belongs in a Bootstrap
class instead.
"""

STYLE_CSS = """
  .live-dot { width: 9px; height: 9px; border-radius: 50%; background: #555; transition: background-color .3s; }
  .live-dot.ok { background: #27ae60; }

  .meas-value { font-size: 18px; font-weight: 300; color: #d0d0d0; line-height: 1.2; }
  .meas-value.warn { color: #f0c020; }
  .meas-label { font-size: 10px; color: #6c757d; letter-spacing: .5px; text-transform: uppercase; }

  .battery-outer, .thermo-wrap { display: flex; flex-direction: column; align-items: center; }
  .battery-tip { width: 26px; height: 7px; background: #4a4a4a; border-radius: 3px 3px 0 0; }
  .battery-body {
    position: relative;
    width: 70px; height: 150px;
    border: 3px solid #4a4a4a;
    border-top: none;
    border-radius: 0 0 10px 10px;
    overflow: hidden;
    background: #111;
  }
  .battery-fill {
    position: absolute; bottom: 0; left: 0; right: 0; height: 0%;
    background: #27ae60;
    transition: height 0.4s ease, background-color 0.5s ease;
  }
  .battery-pct {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    font-size: 17px; font-weight: 700; color: #fff;
    text-shadow: 0 1px 6px rgba(0,0,0,0.9); white-space: nowrap;
  }

  .thermo-wrap { gap: 5px; }
  .thermo-cap { font-size: 9px; color: #6c757d; }
  .thermo-track {
    position: relative; width: 14px; height: 150px;
    background: #1a1a1a; border: 2px solid #4a4a4a; border-radius: 7px 7px 0 0;
    overflow: hidden;
  }
  .thermo-fill {
    position: absolute; bottom: 0; left: 0; right: 0; height: 0%;
    background: #27ae60;
    transition: height 0.4s ease, background-color 0.5s ease;
  }
  .thermo-bulb {
    width: 20px; height: 20px; border-radius: 50%;
    background: #27ae60; border: 2px solid #4a4a4a;
    transition: background-color 0.5s ease; margin-top: -2px;
  }

  .chart-tabs .nav-link { font-size: 11px; padding: 3px 8px; }

  .knob-wrap { position: relative; width: 72px; height: 72px; display: flex; align-items: center; justify-content: center; }
  .knob-label { position: absolute; font-size: 9px; color: #555; user-select: none; line-height: 1; }
  .knob-label-off { left: 2px; bottom: 2px; }
  .knob-label-mid { top: 0; left: 50%; transform: translateX(-50%); }
  .knob-label-on  { right: 2px; bottom: 2px; }
  .knob-label.active { color: #0078d4; font-weight: 600; }

  #speed-top { max-width: 220px; }

  .pedal-track { height: 150px; display: flex; align-items: center; justify-content: center; }
  .pedal-track input[type="range"] { width: 150px; transform: rotate(-90deg); }

  .knob {
    width: 44px; height: 44px; border-radius: 50%;
    background: radial-gradient(circle at 38% 35%, #5a5a5a, #252525);
    border: 2px solid #606060; position: relative; cursor: pointer;
    transition: transform 0.25s cubic-bezier(.4,2,.6,1); user-select: none;
    box-shadow: 0 3px 8px rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.08);
  }
  .knob:hover { border-color: #0078d4; }
  .knob-marker {
    position: absolute; top: 5px; left: 50%; transform: translateX(-50%);
    width: 4px; height: 11px; background: #0078d4; border-radius: 2px;
  }
  .temp-glyph { flex-shrink: 0; }
  .car-rim { fill: #23262c; stroke: #101216; stroke-width: 1; }
  .car-spoke { stroke: #8d939d; stroke-width: 1.6; stroke-linecap: round; }
  .car-lamp { fill: #4a1f1f; }
  .car-lamp.on { fill: #ff3b30; }
  .car-plug { fill: #3a3a3a; stroke: #6c757d; stroke-width: 2; }
  .car-cable { stroke: #6c757d; stroke-width: 3; fill: none; }
  .car-flow { fill: #27ae60; }
"""
