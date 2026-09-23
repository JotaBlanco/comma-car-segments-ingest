"""The dashboard script: controls, polling, rolling charts.

Shares one <script> scope with page_vehicle.py and calls into it with each
poll (vehicleOnTick), with the brake pedal (vehicleSetBrake) and with the
liveness verdict (vehicleSetStalled).
"""

DASHBOARD_JS = """
  const POLL_MS = 150;          // ~6.7 Hz, within the 5-10 Hz polling band
  const SEND_THROTTLE_MS = 150; // matches poll cadence; plant ticks at 10 Hz
  const MAX_POINTS = 400;       // 60 s of WALL clock at POLL_MS - at time
                                // scale N that window spans N x 60 s of sim
                                // time, which is what the x N chart suffix says

  let CFG = {
    pedal_discharge_max_w: 250000,
    pedal_charge_regen_max_w: 80000,
    dc_charge_max_w: 250000,
    derate_band_start_c: 50.0,
    derate_hard_limit_c: 60.0,
    time_scale_min: 1,
    time_scale_max: 50,
  };

  // Raw 0-100 % pedal/charge/ambient/heater/chiller state plus the time scale.
  // requested_power_w is never computed or stored here - the server is the
  // single source of truth for the pedal law (main.py requested_power_w());
  // the sign the browser cares about is battery-sign, computed independently
  // below. The whole object is POSTed on every change.
  const state = {
    accel_pct: 0, brake_pct: 0,
    charge_plug: false, charge_rate_w: 0,
    ambient_temp_c: 15, heater_setting: 0, chiller_setting: 0,
    time_scale: 1,
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
  const speedSliders = document.querySelectorAll('.speed-slider');

  accelSlider.addEventListener('input', () => {
    state.accel_pct = Number(accelSlider.value);
    document.getElementById('accel-val').textContent = state.accel_pct + ' %';
    scheduleSend();
  });
  brakeSlider.addEventListener('input', () => {
    state.brake_pct = Number(brakeSlider.value);
    vehicleSetBrake(state.brake_pct);
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
      vehicleSetBrake(0);
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

  // Sim speed: two sliders (header at >= sm, controls row below it), wired as
  // one class so both show the same value. `speedTouched` is what stops the
  // plant's echo from moving a knob the user is holding; until the first
  // touch the echo is exactly what restores the knob across a reload.
  let speedTouched = false;
  function showSpeed(n) {
    speedSliders.forEach((el) => { el.value = n; });
    document.querySelectorAll('.speed-badge').forEach((el) => { el.textContent = '×' + n; });
    document.querySelectorAll('.chart-scale').forEach((el) => { el.textContent = '×' + n; });
  }
  speedSliders.forEach((el) => el.addEventListener('input', () => {
    speedTouched = true;
    state.time_scale = Number(el.value);
    car.time_scale = state.time_scale;
    showSpeed(state.time_scale);
    scheduleSend();
  }));

  function wireKnob(which) {
    const knob = document.getElementById(which + '-knob');
    const posLabel = document.getElementById(which + '-pos');
    function applyPos(pos) {
      knob.style.transform = `rotate(${KNOB_ANGLES[pos]}deg)`;
      posLabel.textContent = KNOB_LABELS[pos];
      knob.parentElement.querySelectorAll('.knob-label').forEach((el, i) => {
        el.classList.toggle('active', i === pos);
      });
    }
    applyPos(state[which + '_setting']);
    knob.addEventListener('click', () => {
      const next = (state[which + '_setting'] + 1) % 3;
      state[which + '_setting'] = next;
      applyPos(next);
      scheduleSend();
    });
    return applyPos;
  }
  const applyChiller = wireKnob('chiller');
  const applyHeater = wireKnob('heater');

  document.querySelectorAll('#chart-tabs .nav-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#chart-tabs .nav-link').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeSeries = btn.dataset.series;
      sizeCanvas();
      drawActive();
    });
  });

  // --- Rolling chart -------------------------------------------------------
  // Fixed scales taken from signals.json's own declared min/max per signal,
  // not invented - so a chart's range never silently drifts from the plant's
  // contract. All four buffers fill on every poll; switching tabs reveals
  // history rather than resetting it.
  let activeSeries = 'soc';
  const series = {
    soc: { buf: [], min: 0, max: 100, unit: '%', step: 25 },
    current: { buf: [], min: -400, max: 400, unit: 'A', step: 200 },
    temp: { buf: [], min: -40, max: 70, bands: true, unit: '°C', step: 20 },
    voltage: { buf: [], min: 600, max: 900, unit: 'V', step: 100 },
  };
  const ACCENT = '#0078d4';

  // The canvas is sized from its flex-grow parent; clientWidth/Height are
  // valid after layout completes (first call deferred via rAF at startup).
  function sizeCanvas() {
    const canvas = document.getElementById('chart-main');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  function drawActive() { drawChart(series[activeSeries]); }
  window.addEventListener('resize', () => { sizeCanvas(); drawActive(); });

  function pushPoint(key, value) {
    const buf = series[key].buf;
    buf.push(value);
    if (buf.length > MAX_POINTS) buf.shift();
  }

  // Plot box inset from the canvas, leaving room for the two scales.
  const PAD = { l: 46, r: 8, t: 8, b: 20 };

  function drawChart(s) {
    const canvas = document.getElementById('chart-main');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const x0 = PAD.l, x1 = w - PAD.r, y0 = PAD.t, y1 = h - PAD.b;
    const plotW = x1 - x0, plotH = y1 - y0;
    if (plotW < 20 || plotH < 20) return;
    const yOf = (v) => y1 - ((v - s.min) / (s.max - s.min)) * plotH;

    if (s.bands) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, plotW, plotH); ctx.clip();
      ctx.fillStyle = 'rgba(240,192,32,0.18)';
      ctx.fillRect(x0, yOf(CFG.derate_hard_limit_c), plotW,
                   yOf(CFG.derate_band_start_c) - yOf(CFG.derate_hard_limit_c));
      ctx.fillStyle = 'rgba(231,76,60,0.18)';
      ctx.fillRect(x0, y0, plotW, yOf(CFG.derate_hard_limit_c) - y0);
      ctx.restore();
    }

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8b939e';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = s.min; v <= s.max + 1e-9; v += s.step) {
      const y = yOf(v);
      ctx.strokeStyle = v === 0 ? '#555c66' : '#2a2f36';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(String(v), x0 - 6, y);
    }

    // The window is MAX_POINTS polls of SIM time, so the scale stretches with
    // TIME_SCALE: the axis states what the samples actually span.
    const spanS = (MAX_POINTS * POLL_MS / 1000) * (car.time_scale || 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (i / 4) * plotW;
      ctx.strokeStyle = '#2a2f36';
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      const ago = spanS * (1 - i / 4);
      ctx.fillText(ago === 0 ? 'now' : '-' + (ago >= 100 ? ago.toFixed(0) : ago.toFixed(1)) + 's',
                   x, y1 + 4);
    }

    ctx.strokeStyle = '#555c66';
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.save();
    ctx.translate(12, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8b939e';
    ctx.fillText(s.unit, 0, 0);
    ctx.restore();

    const buf = s.buf;
    if (buf.length < 2) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, plotW, plotH); ctx.clip();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    buf.forEach((v, i) => {
      const x = x0 + (i / (MAX_POINTS - 1)) * plotW;
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
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

    const echoed = data.applied?.parameters?.TIME_SCALE;
    if (echoed !== undefined) {
      car.time_scale = echoed;
      if (!speedTouched) { state.time_scale = echoed; showSpeed(echoed); }
    }
    const echoChiller = data.applied?.parameters?.CHILLER_SETTING;
    if (echoChiller !== undefined) { state.chiller_setting = echoChiller; applyChiller(echoChiller); }
    const echoHeater = data.applied?.parameters?.HEATER_SETTING;
    if (echoHeater !== undefined) { state.heater_setting = echoHeater; applyHeater(echoHeater); }

    vehicleOnTick(v, iAch, state.charge_plug);

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
    derateEl.classList.toggle('warn', derate < 1.0);
    document.getElementById('derate-label').textContent =
      derate >= 1.0 ? 'Derating Factor (nominal)' : 'Derating Factor (ACTIVE)';

    if (temp !== null) {
      const pct = ((temp - (-40)) / (70 - (-40))) * 100;
      const color = thermoColor(temp);
      document.getElementById('thermo-fill').style.height = clamp(pct, 0, 100).toFixed(1) + '%';
      document.getElementById('thermo-fill').style.backgroundColor = color;
      document.getElementById('thermo-bulb').style.backgroundColor = color;
      document.getElementById('temp-value').textContent = temp.toFixed(1) + ' °C';
      document.getElementById('temp-cell').style.color = color;
    }

    pushPoint('soc', soc);
    pushPoint('current', iAch);
    pushPoint('temp', temp !== null ? temp : 0);
    pushPoint('voltage', v);
    drawActive();
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
    vehicleSetStalled(!live);
    setTimeout(poll, POLL_MS);
  }

  async function loadConfig() {
    const r = await fetch('/config');
    CFG = await r.json();
    chargeSlider.max = CFG.dc_charge_max_w;
    speedSliders.forEach((el) => {
      el.min = CFG.time_scale_min;
      el.max = CFG.time_scale_max;
    });
    VEH.mass_kg = CFG.vehicle_mass_kg;
    VEH.k_drag_n_per_mps2 = CFG.k_drag_n_per_mps2;
    VEH.k_roll_n = CFG.k_roll_n;
    VEH.k_lin_n_per_mps = CFG.k_lin_n_per_mps;
    VEH.driveline_eff = CFG.driveline_eff;
    VEH.v_floor_mps = CFG.v_floor_mps;
    VEH.wheel_radius_m = CFG.wheel_radius_m;
    VEH.f_brake_max_n = CFG.f_brake_max_n;
  }

  requestAnimationFrame(sizeCanvas);
  loadConfig().then(poll);
"""
