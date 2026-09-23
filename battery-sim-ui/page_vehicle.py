"""The browser-side vehicle model: pack power -> road speed -> wheel rotation.

The plant is a pack model and publishes no road speed, so the car's motion is
integrated here from the achieved electrical power. Integration runs in SIM
time (dt_wall x TIME_SCALE), so the car and the SOC move on the same clock.

Shares one <script> scope with page_script.py: this half owns `VEH` and `car`
and exposes vehicleOnTick() / vehicleSetStalled() to the other half.
"""

VEHICLE_JS = """
  // Display constants, seeded from GET /config (main.py's vehicle block).
  const VEH = {
    mass_kg: 2000.0,
    k_drag_n_per_mps2: 0.40,
    k_roll_n: 196.0,
    driveline_eff: 0.90,
    v_floor_mps: 15.0,
    wheel_radius_m: 0.34,
  };

  // 2 rev/s. Above it the five spokes alias at 60 fps and the wheel reads as
  // turning backwards. This bounds the DRAWING only: v_mps integrates
  // unclamped and the km/h readout carries the true value.
  const MAX_DISPLAY_RAD_S = 4 * Math.PI;

  const WHEELS = [['wheel-rear', 118, 132], ['wheel-front', 318, 132]];

  const car = {
    p_pack_w: 0,      // dc_voltage_v * dc_current_a, battery-sign: + discharge
    current_a: 0,
    v_mps: 0,
    angle_deg: 0,
    time_scale: 1,    // last applied.parameters.TIME_SCALE echo from the plant
    mode: 'Coast',
    charging: false,
    stalled: false,
  };

  // Drive / Coast / Regen are the sign of the achieved current, not of the
  // pedal: when derating engages, dc_current_a falls and the car stops pulling
  // while the pedal has not moved. Charging is the one case the browser's own
  // plug state decides - a negative current alone cannot tell a plug from
  // regen.
  function vehicleOnTick(voltageV, currentA, plugged) {
    car.p_pack_w = voltageV * currentA;
    car.current_a = currentA;
    car.charging = plugged;
    car.mode = plugged ? 'Charging'
      : currentA > 0 ? 'Drive'
      : currentA < 0 ? 'Regen'
      : 'Coast';
  }

  function vehicleSetStalled(stalled) { car.stalled = stalled; }

  function vehicleStep(dtWallS) {
    if (car.stalled) return;
    if (car.charging) { car.v_mps = 0; return; }

    const fTrac = (car.p_pack_w * VEH.driveline_eff) / Math.max(car.v_mps, VEH.v_floor_mps);
    const fResist = VEH.k_drag_n_per_mps2 * car.v_mps * car.v_mps + VEH.k_roll_n;
    const accel = (fTrac - fResist) / VEH.mass_kg;
    car.v_mps = Math.max(0, car.v_mps + accel * dtWallS * car.time_scale);

    if (car.v_mps < 0.1) return;  // standstill: the wheels hold their angle
    const omega = car.v_mps / VEH.wheel_radius_m;
    const shownRad = Math.min(omega * car.time_scale, MAX_DISPLAY_RAD_S);
    car.angle_deg = (car.angle_deg + shownRad * (180 / Math.PI) * dtWallS) % 360;
  }

  function vehicleRender() {
    for (const [id, cx, cy] of WHEELS) {
      document.getElementById(id)
        .setAttribute('transform', 'rotate(' + car.angle_deg.toFixed(1) + ' ' + cx + ' ' + cy + ')');
    }
    document.getElementById('speed-kph').textContent = (car.v_mps * 3.6).toFixed(0);
    document.getElementById('mode-chip').textContent = car.stalled ? 'Stalled' : car.mode;
    document.getElementById('car-svg').classList.toggle('opacity-50', car.stalled);
    document.querySelectorAll('.car-lamp')
      .forEach((el) => el.classList.toggle('on', car.mode === 'Regen'));
    document.getElementById('charge-cable')
      .setAttribute('visibility', car.charging ? 'visible' : 'hidden');
    document.getElementById('charge-flow')
      .setAttribute('width', (Math.min(Math.abs(car.current_a), 400) / 400 * 26).toFixed(1));
  }

  // The poll updates omega; rAF advances the angle. At 6.7 Hz polling a fast
  // wheel would jump whole revolutions per update - a strobe, not a wheel.
  let lastFrameMs = 0;
  function vehicleFrame(nowMs) {
    vehicleStep(lastFrameMs ? (nowMs - lastFrameMs) / 1000 : 0);
    lastFrameMs = nowMs;
    vehicleRender();
    requestAnimationFrame(vehicleFrame);
  }
  requestAnimationFrame(vehicleFrame);
"""
