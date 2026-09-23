"""The browser-side vehicle model: pack power -> road speed -> wheel rotation.

The plant is a pack model and publishes no road speed, so the car's motion is
integrated here from the achieved electrical power and from the friction brake,
which is mechanical and reaches no signal the plant sees. Integration runs in
SIM time (dt_wall x TIME_SCALE), so the car and the SOC move on the same clock.

Shares one <script> scope with page_script.py: this half owns `VEH` and `car`
and exposes vehicleOnTick() / vehicleSetBrake() / vehicleSetStalled() to the
other half.
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
    f_brake_max_n: 14700.0,
  };

  // Pedal travel at which the discs start to bite. Below it the brake is regen
  // only; above it both act, which is what a blended brake does.
  const BRAKE_FRICTION_PCT = 50;

  // 2 rev/s. Above it the five spokes alias at 60 fps and the wheel reads as
  // turning backwards. This bounds the DRAWING only: v_mps integrates
  // unclamped and the km/h readout carries the true value.
  const MAX_DISPLAY_RAD_S = 4 * Math.PI;

  const WHEELS = [['wheel-rear', 118, 132], ['wheel-front', 318, 132]];

  const car = {
    p_pack_w: 0,      // dc_voltage_v * dc_current_a, battery-sign: + discharge
    current_a: 0,
    brake_pct: 0,     // pedal travel, from the browser's own control state
    v_mps: 0,
    angle_deg: 0,
    time_scale: 1,    // last applied.parameters.TIME_SCALE echo from the plant
    charging: false,
    stalled: false,
  };

  function vehicleOnTick(voltageV, currentA, plugged) {
    car.p_pack_w = voltageV * currentA;
    car.current_a = currentA;
    car.charging = plugged;
  }

  function vehicleSetBrake(pct) { car.brake_pct = pct; }
  function vehicleSetStalled(stalled) { car.stalled = stalled; }

  // Drive / Coast / Regen are the sign of the achieved current, not of the
  // pedal: when derating engages, dc_current_a falls and the car stops pulling
  // while the pedal has not moved. Braking outranks them past
  // BRAKE_FRICTION_PCT, where the discs do the retarding and no pack current
  // can show it. Charging is the one case the browser's own plug state decides
  // - a negative current alone cannot tell a plug from regen.
  function vehicleMode() {
    if (car.stalled) return 'Stalled';
    if (car.charging) return 'Charging';
    if (car.brake_pct > BRAKE_FRICTION_PCT) return 'Braking';
    return car.current_a > 0 ? 'Drive' : car.current_a < 0 ? 'Regen' : 'Coast';
  }

  // Newtons of disc braking: nothing up to BRAKE_FRICTION_PCT, then linear to
  // f_brake_max_n at full pedal. Mechanical only - regen keeps running at its
  // own ceiling underneath it and the pack never sees this force.
  function frictionBrakeN() {
    const over = car.brake_pct - BRAKE_FRICTION_PCT;
    return over > 0 ? (over / (100 - BRAKE_FRICTION_PCT)) * VEH.f_brake_max_n : 0;
  }

  function vehicleStep(dtWallS) {
    if (car.stalled) return;
    if (car.charging) { car.v_mps = 0; return; }

    const fTrac = (car.p_pack_w * VEH.driveline_eff) / Math.max(car.v_mps, VEH.v_floor_mps);
    const fResist = VEH.k_drag_n_per_mps2 * car.v_mps * car.v_mps + VEH.k_roll_n;
    const accel = (fTrac - fResist - frictionBrakeN()) / VEH.mass_kg;
    // Drag, rolling and the discs only dissipate: a step that would carry the
    // car past zero lands on zero, so full pedal stops it instead of reversing
    // it, and at rest the brake contributes nothing.
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
    document.getElementById('mode-chip').textContent = vehicleMode();
    document.getElementById('car-svg').classList.toggle('opacity-50', car.stalled);
    document.querySelectorAll('.car-lamp')
      .forEach((el) => el.classList.toggle('on', car.brake_pct > 0));
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
