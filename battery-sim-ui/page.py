"""The dashboard page: one module-level HTML string, served verbatim by main.py.

No build step, no template engine, no frontend framework - vanilla JS + CSS,
matching the uiservice template's shape. Split out of main.py purely for file
length (quixstreams-idioms sec 0's 300-line trigger is about topology code;
this is markup, but the seam is still worth taking at this size).
"""

PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Battery Simulator</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1b1b1b;
    color: #e8e8e8;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 20px;
  }
  .dashboard {
    background: #2b2b2b;
    border: 1px solid #3e3e3e;
    border-radius: 12px;
    padding: 28px 32px;
    width: 100%;
    max-width: 1080px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }

  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .topbar h1 { font-size: 20px; font-weight: 600; color: #fff; }
  .live { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #999; }
  .live-dot { width: 9px; height: 9px; border-radius: 50%; background: #555; transition: background-color .3s; }
  .live-dot.ok { background: #27ae60; }

  .gauges-row {
    display: flex;
    align-items: flex-end;
    gap: 28px;
    margin-bottom: 20px;
  }
  .readouts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 28px;
    flex: 1;
  }
  .meas-item { text-align: left; }
  .meas-value { font-size: 20px; font-weight: 300; color: #d0d0d0; }
  .meas-value.warn { color: #f0c020; }
  .meas-label { font-size: 11px; color: #666; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .meas-label small { text-transform: none; letter-spacing: 0; color: #555; }

  .battery-outer, .thermo-wrap { display: flex; flex-direction: column; align-items: center; }
  .battery-tip { width: 28px; height: 8px; background: #4a4a4a; border-radius: 3px 3px 0 0; }
  .battery-body {
    position: relative;
    width: 78px; height: 150px;
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
    font-size: 19px; font-weight: 700; color: #fff;
    text-shadow: 0 1px 6px rgba(0,0,0,0.9); white-space: nowrap;
  }

  .thermo-wrap { gap: 6px; }
  .thermo-label-top { font-size: 10px; color: #555; text-align: center; }
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
    width: 22px; height: 22px; border-radius: 50%;
    background: #27ae60; border: 2px solid #4a4a4a;
    transition: background-color 0.5s ease; margin-top: -2px;
  }
  .thermo-temp { font-size: 12px; font-weight: 600; color: #ccc; white-space: nowrap; }

  hr { border: none; border-top: 1px solid #3a3a3a; margin: 4px 0 20px; }

  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
  .chart-box { background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 8px; padding: 10px 12px; }
  .chart-box h3 {
    font-size: 10px; text-transform: uppercase; letter-spacing: .5px;
    color: #888; font-weight: 600; margin-bottom: 6px;
  }
  .chart-box canvas { width: 100%; height: 90px; display: block; }

  .controls-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 28px;
  }

  .ctrl-label {
    font-size: 11px; color: #777;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 6px;
  }

  .pedal-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .pedal-track { width: 60px; height: 160px; display: flex; align-items: center; justify-content: center; }
  .pedal-track input[type="range"] {
    width: 150px;
    transform: rotate(-90deg);
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
  }
  .pedal-track input[type="range"]::-webkit-slider-runnable-track {
    height: 8px; border-radius: 4px; background: #1a1a1a; border: 1px solid #4a4a4a;
  }
  .pedal-track input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%;
    background: #0078d4; border: 2px solid #cfe6fb; margin-top: -7px; cursor: pointer;
  }
  .pedal-track input[type="range"]::-moz-range-track {
    height: 8px; border-radius: 4px; background: #1a1a1a; border: 1px solid #4a4a4a;
  }
  .pedal-track input[type="range"]::-moz-range-thumb {
    width: 18px; height: 18px; border-radius: 50%;
    background: #0078d4; border: 2px solid #cfe6fb; cursor: pointer;
  }
  input[type="range"]:disabled { opacity: 0.35; cursor: not-allowed; }
  .pedal-val { font-size: 13px; color: #ccc; }

  .charge-col, .side-col { display: flex; flex-direction: column; gap: 6px; min-width: 170px; }
  .charge-col input[type="range"], .side-col input[type="range"] { width: 170px; }

  .switch { position: relative; display: inline-block; width: 46px; height: 24px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider-track {
    position: absolute; inset: 0; background: #3a3a3a; border-radius: 24px;
    transition: .2s; cursor: pointer;
  }
  .slider-track:before {
    content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px;
    background: #ccc; border-radius: 50%; transition: .2s;
  }
  .switch input:checked + .slider-track { background: #0078d4; }
  .switch input:checked + .slider-track:before { transform: translateX(22px); background: #fff; }

  .knob-row { display: flex; align-items: center; gap: 14px; }
  .knob-outer { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .knob {
    width: 48px; height: 48px; border-radius: 50%;
    background: radial-gradient(circle at 38% 35%, #5a5a5a, #252525);
    border: 2px solid #606060; position: relative; cursor: pointer;
    transition: transform 0.25s cubic-bezier(.4,2,.6,1); user-select: none;
    box-shadow: 0 3px 8px rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.08);
  }
  .knob:hover { border-color: #0078d4; }
  .knob-marker {
    position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
    width: 4px; height: 12px; background: #0078d4; border-radius: 2px;
  }
  .knob-pos { font-size: 11px; color: #888; text-align: center; }
</style>
</head>
<body>
<div class="dashboard">
  <div class="topbar">
    <h1>Battery Sim</h1>
    <div class="live"><span class="live-dot" id="live-dot"></span><span id="live-text">connecting&hellip;</span></div>
  </div>

  <div class="gauges-row">
    <div class="battery-outer">
      <div class="battery-tip"></div>
      <div class="battery-body">
        <div class="battery-fill" id="soc-fill"></div>
        <span class="battery-pct" id="soc-pct">-- %</span>
      </div>
    </div>

    <div class="thermo-wrap">
      <div class="thermo-label-top">+70</div>
      <div class="thermo-track"><div class="thermo-fill" id="thermo-fill"></div></div>
      <div class="thermo-bulb" id="thermo-bulb"></div>
      <div class="thermo-label-top">-40</div>
      <div class="thermo-temp" id="thermo-temp">-- &deg;C</div>
    </div>

    <div class="readouts">
      <div class="meas-item">
        <div class="meas-value"><span id="voltage">---</span> V</div>
        <div class="meas-label">Terminal Voltage</div>
      </div>
      <div class="meas-item">
        <div class="meas-value" id="derate-value">---</div>
        <div class="meas-label" id="derate-label">Derating Factor</div>
      </div>
      <div class="meas-item">
        <div class="meas-value"><span id="current-ach">---</span> A</div>
        <div class="meas-label">Current &mdash; achieved<br><small>battery-sign: + discharge / &minus; charge</small></div>
      </div>
      <div class="meas-item">
        <div class="meas-value"><span id="current-cmd">---</span> A</div>
        <div class="meas-label">Current &mdash; commanded (est.)<br><small>same sign convention</small></div>
      </div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-box"><h3>SOC %</h3><canvas id="chart-soc" width="480" height="90"></canvas></div>
    <div class="chart-box"><h3>Current A &mdash; battery-sign: + discharge / &minus; charge</h3><canvas id="chart-current" width="480" height="90"></canvas></div>
    <div class="chart-box"><h3>Temperature &deg;C &mdash; amber &ge;50, red &ge;60 (derating band)</h3><canvas id="chart-temp" width="480" height="90"></canvas></div>
    <div class="chart-box"><h3>Terminal Voltage V</h3><canvas id="chart-voltage" width="480" height="90"></canvas></div>
  </div>

  <hr>

  <div class="controls-row">
    <div class="pedal-wrap">
      <div class="ctrl-label">Accel</div>
      <div class="pedal-track"><input type="range" id="accel-slider" min="0" max="100" step="1" value="0"></div>
      <div class="pedal-val" id="accel-val">0 %</div>
    </div>
    <div class="pedal-wrap">
      <div class="ctrl-label">Brake</div>
      <div class="pedal-track"><input type="range" id="brake-slider" min="0" max="100" step="1" value="0"></div>
      <div class="pedal-val" id="brake-val">0 %</div>
    </div>

    <div class="charge-col">
      <div class="ctrl-label">Charge Plug</div>
      <label class="switch"><input type="checkbox" id="plug-toggle"><span class="slider-track"></span></label>
      <div class="ctrl-label" style="margin-top:10px;">Charge Rate</div>
      <input type="range" id="charge-slider" min="0" max="250000" step="1000" value="0" disabled>
      <div class="pedal-val" id="charge-val">0.0 kW</div>
    </div>

    <div class="side-col">
      <div class="ctrl-label">Ambient Temperature</div>
      <input type="range" id="ambient-slider" min="-40" max="60" step="1" value="15">
      <div class="pedal-val" id="ambient-val">15 &deg;C</div>
    </div>

    <div class="side-col">
      <div class="ctrl-label">Chiller</div>
      <div class="knob-row">
        <div class="knob-outer">
          <div class="knob" id="chiller-knob"><div class="knob-marker"></div></div>
          <div class="knob-pos" id="chiller-pos">OFF</div>
        </div>
      </div>
    </div>

    <div class="side-col">
      <div class="ctrl-label">Heater</div>
      <div class="knob-row">
        <div class="knob-outer">
          <div class="knob" id="heater-knob"><div class="knob-marker"></div></div>
          <div class="knob-pos" id="heater-pos">OFF</div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
  const POLL_MS = 150;          // ~6.7 Hz, within the 5-10 Hz polling band
  const SEND_THROTTLE_MS = 150; // matches poll cadence; plant ticks at 10 Hz
  const MAX_POINTS = 400;       // 60 s rolling window at POLL_MS

  let CFG = {
    pedal_discharge_max_w: 60000,
    pedal_charge_regen_max_w: 20000,
    dc_charge_max_w: 250000,
    derate_band_start_c: 50.0,
    derate_hard_limit_c: 60.0,
  };

  // Raw 0-100 % pedal/charge/ambient/heater/chiller state. requested_power_w
  // is never computed or stored here - the server is the single source of
  // truth for the pedal law (main.py requested_power_w()); the sign the
  // browser cares about is battery-sign, computed independently below.
  const state = {
    accel_pct: 0, brake_pct: 0,
    charge_plug: false, charge_rate_w: 0,
    ambient_temp_c: 15, heater_setting: 0, chiller_setting: 0,
  };

  const KNOB_ANGLES = [-135, 0, 135];
  const KNOB_LABELS = ['OFF', '1', '2'];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Commanded power in battery-sign (+ discharge / - charge), derived purely
  // from local pedal/charge state and the fetched ceilings - never from the
  // plant's powertrain-sign requested_power_w, which this page never reads.
  function commandedPowerBatterySignW() {
    if (state.charge_plug) return -state.charge_rate_w;
    const net = clamp(state.accel_pct - state.brake_pct, -100, 100);
    return net >= 0
      ? (net / 100) * CFG.pedal_discharge_max_w
      : (net / 100) * CFG.pedal_charge_regen_max_w;
  }

  let sendTimer = null;
  function scheduleSend() {
    if (sendTimer) return;
    sendTimer = setTimeout(() => { sendTimer = null; postCommand(); }, SEND_THROTTLE_MS);
  }
  function postCommand() {
    fetch('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {});
  }

  const accelSlider = document.getElementById('accel-slider');
  const brakeSlider = document.getElementById('brake-slider');
  const chargeSlider = document.getElementById('charge-slider');
  const plugToggle = document.getElementById('plug-toggle');
  const ambientSlider = document.getElementById('ambient-slider');

  accelSlider.addEventListener('input', () => {
    state.accel_pct = Number(accelSlider.value);
    document.getElementById('accel-val').textContent = state.accel_pct + ' %';
    scheduleSend();
  });
  brakeSlider.addEventListener('input', () => {
    state.brake_pct = Number(brakeSlider.value);
    document.getElementById('brake-val').textContent = state.brake_pct + ' %';
    scheduleSend();
  });

  plugToggle.addEventListener('change', () => {
    state.charge_plug = plugToggle.checked;
    accelSlider.disabled = state.charge_plug;
    brakeSlider.disabled = state.charge_plug;
    chargeSlider.disabled = !state.charge_plug;
    if (state.charge_plug) {
      state.accel_pct = 0; state.brake_pct = 0;
      accelSlider.value = 0; brakeSlider.value = 0;
      document.getElementById('accel-val').textContent = '0 %';
      document.getElementById('brake-val').textContent = '0 %';
    } else {
      state.charge_rate_w = 0;
      chargeSlider.value = 0;
      document.getElementById('charge-val').textContent = '0.0 kW';
    }
    scheduleSend();
  });

  chargeSlider.addEventListener('input', () => {
    state.charge_rate_w = Number(chargeSlider.value);
    document.getElementById('charge-val').textContent = (state.charge_rate_w / 1000).toFixed(1) + ' kW';
    scheduleSend();
  });

  ambientSlider.addEventListener('input', () => {
    state.ambient_temp_c = Number(ambientSlider.value);
    document.getElementById('ambient-val').textContent = state.ambient_temp_c + ' °C';
    scheduleSend();
  });

  function wireKnob(which) {
    const knob = document.getElementById(which + '-knob');
    knob.addEventListener('click', () => {
      const next = (state[which + '_setting'] + 1) % 3;
      state[which + '_setting'] = next;
      knob.style.transform = `rotate(${KNOB_ANGLES[next]}deg)`;
      document.getElementById(which + '-pos').textContent = KNOB_LABELS[next];
      scheduleSend();
    });
  }
  wireKnob('chiller');
  wireKnob('heater');

  // --- Rolling charts -----------------------------------------------------
  // Fixed scales taken from signals.json's own declared min/max per signal,
  // not invented - so a chart's range never silently drifts from the plant's
  // contract.
  const series = {
    soc: { buf: [], min: 0, max: 100, canvas: 'chart-soc' },
    current: { buf: [], min: -400, max: 400, canvas: 'chart-current' },
    temp: { buf: [], min: -40, max: 70, canvas: 'chart-temp', bands: true },
    voltage: { buf: [], min: 600, max: 900, canvas: 'chart-voltage' },
  };
  const ACCENT = '#0078d4';

  function pushPoint(key, value) {
    const buf = series[key].buf;
    buf.push(value);
    if (buf.length > MAX_POINTS) buf.shift();
  }

  function drawChart(s) {
    const canvas = document.getElementById(s.canvas);
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const yOf = (v) => h - ((v - s.min) / (s.max - s.min)) * h;

    if (s.bands) {
      ctx.fillStyle = 'rgba(240,192,32,0.18)';
      ctx.fillRect(0, yOf(CFG.derate_hard_limit_c), w, yOf(CFG.derate_band_start_c) - yOf(CFG.derate_hard_limit_c));
      ctx.fillStyle = 'rgba(231,76,60,0.18)';
      ctx.fillRect(0, 0, w, yOf(CFG.derate_hard_limit_c));
    }

    if (s.min < 0 && s.max > 0) {
      ctx.strokeStyle = '#444';
      ctx.beginPath();
      ctx.moveTo(0, yOf(0));
      ctx.lineTo(w, yOf(0));
      ctx.stroke();
    }

    const buf = s.buf;
    if (buf.length < 2) return;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    buf.forEach((v, i) => {
      const x = (i / (MAX_POINTS - 1)) * w;
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function thermoColor(t) {
    if (t < 0) return '#3498db';
    if (t < CFG.derate_band_start_c) return '#27ae60';
    if (t < CFG.derate_hard_limit_c) return '#f0c020';
    return '#e74c3c';
  }

  function updateUI(data) {
    const soc = Number(data.soc_percent) || 0;
    const v = Number(data.dc_voltage_v) || 0;
    const iAch = Number(data.dc_current_a) || 0;
    const temp = data.temperature_c !== undefined ? Number(data.temperature_c) : null;
    const derate = data.derating_factor !== undefined ? Number(data.derating_factor) : 1.0;

    document.getElementById('soc-pct').textContent = soc.toFixed(1) + ' %';
    const fill = document.getElementById('soc-fill');
    fill.style.height = clamp(soc, 0, 100).toFixed(1) + '%';
    fill.style.backgroundColor = soc <= 20 ? '#e74c3c' : soc <= 50 ? '#f0c020' : '#27ae60';

    document.getElementById('voltage').textContent = v.toFixed(1);
    document.getElementById('current-ach').textContent = (iAch >= 0 ? '+' : '') + iAch.toFixed(1);

    const commandedW = commandedPowerBatterySignW();
    const iCmd = v > 1 ? commandedW / v : 0;
    document.getElementById('current-cmd').textContent = (iCmd >= 0 ? '+' : '') + iCmd.toFixed(1);

    const derateEl = document.getElementById('derate-value');
    derateEl.textContent = (derate * 100).toFixed(0) + ' %';
    derateEl.className = derate < 1.0 ? 'meas-value warn' : 'meas-value';
    document.getElementById('derate-label').textContent =
      derate >= 1.0 ? 'Derating Factor (nominal)' : 'Derating Factor (ACTIVE)';

    if (temp !== null) {
      const pct = ((temp - (-40)) / (70 - (-40))) * 100;
      const color = thermoColor(temp);
      document.getElementById('thermo-fill').style.height = clamp(pct, 0, 100).toFixed(1) + '%';
      document.getElementById('thermo-fill').style.backgroundColor = color;
      document.getElementById('thermo-bulb').style.backgroundColor = color;
      document.getElementById('thermo-temp').textContent = temp.toFixed(1) + ' °C';
    }

    pushPoint('soc', soc);
    pushPoint('current', iAch);
    pushPoint('temp', temp !== null ? temp : 0);
    pushPoint('voltage', v);
    Object.values(series).forEach(drawChart);
  }

  let lastGoodPoll = 0;
  async function poll() {
    try {
      const r = await fetch('/battery/data');
      if (r.ok) {
        const data = await r.json();
        if (Object.keys(data).length > 0) {
          updateUI(data);
          lastGoodPoll = Date.now();
        }
      }
    } catch (_) { /* transient poll failure, retried next tick */ }
    const live = Date.now() - lastGoodPoll < POLL_MS * 4;
    document.getElementById('live-dot').classList.toggle('ok', live);
    document.getElementById('live-text').textContent = live ? 'live' : 'connecting…';
    setTimeout(poll, POLL_MS);
  }

  async function loadConfig() {
    try {
      const r = await fetch('/config');
      if (r.ok) CFG = await r.json();
    } catch (_) { /* keep the built-in defaults */ }
    chargeSlider.max = CFG.dc_charge_max_w;
  }

  loadConfig().then(poll);
</script>
</body>
</html>"""
