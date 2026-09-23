"""The dashboard body: Bootstrap 5.3 grid, the SVG car, and the controls.

Bootstrap owns every layout and breakpoint decision - `row`/`col-*` for the
grid, `order-*` for the phone stacking order (header, car, state, controls,
charts), `d-none d-*-block` for the two elements that collapse, and `ratio` so
the car and the charts size themselves from their column width. The four main
columns live in ONE `row` because `order-*` only reorders siblings.

Opens <body> but does not close it: page.py appends the <script> block and the
closing tags.
"""

BODY_HTML = """<body class="bg-body">
<div class="container-fluid px-3 py-2">

  <header class="d-flex align-items-center justify-content-between gap-3 py-2">
    <h1 class="fs-5 mb-0 text-nowrap">Battery Sim</h1>
    <div class="d-none d-sm-flex align-items-center gap-2 flex-grow-1 justify-content-end">
      <label for="speed-top" class="small text-secondary mb-0 text-nowrap">Simulation speed</label>
      <input type="range" class="form-range speed-slider" id="speed-top" min="1" max="50" step="1" value="1">
      <span class="badge text-bg-secondary speed-badge">&times;1</span>
    </div>
    <div class="d-flex align-items-center gap-2 small text-secondary text-nowrap">
      <span class="live-dot" id="live-dot"></span><span id="live-text">connecting&hellip;</span>
    </div>
  </header>

  <div class="row g-3">

    <div class="col-12 col-md-4 col-lg-3 order-2 order-lg-1">
      <div class="card bg-body-tertiary h-100"><div class="card-body p-3">
        <div class="d-flex gap-3 justify-content-center justify-content-md-start">
          <div class="battery-outer">
            <div class="battery-tip"></div>
            <div class="battery-body">
              <div class="battery-fill" id="soc-fill"></div>
              <span class="battery-pct" id="soc-pct">-- %</span>
            </div>
          </div>
          <div class="thermo-wrap d-none d-md-flex">
            <div class="thermo-cap">+70</div>
            <div class="thermo-track"><div class="thermo-fill" id="thermo-fill"></div></div>
            <div class="thermo-bulb" id="thermo-bulb"></div>
            <div class="thermo-cap">-40</div>
          </div>
        </div>
        <div class="row g-2 mt-1">
          <div class="col-6">
            <div class="meas-value"><span id="voltage">---</span> V</div>
            <div class="meas-label">Terminal Voltage</div>
          </div>
          <div class="col-6">
            <div class="meas-value" id="temp-value">--- &deg;C</div>
            <div class="meas-label">Battery Temperature</div>
          </div>
          <div class="col-6">
            <div class="meas-value" id="derate-value">---</div>
            <div class="meas-label" id="derate-label">Derating Factor</div>
          </div>
          <div class="col-6">
            <div class="meas-value"><span id="current-ach">---</span> A</div>
            <div class="meas-label">Current &mdash; achieved<br>battery-sign: + discharge / &minus; charge</div>
          </div>
          <div class="col-6 d-none d-sm-block">
            <div class="meas-value"><span id="current-cmd">---</span> A</div>
            <div class="meas-label">Current &mdash; commanded (est.)<br>same sign convention</div>
          </div>
        </div>
      </div></div>
    </div>

    <div class="col-12 col-md-8 col-lg-5 order-1 order-lg-2">
      <div class="card bg-body-tertiary h-100"><div class="card-body p-3 d-flex flex-column">
        <div class="ratio ratio-21x9">
          <svg id="car-svg" viewBox="0 0 420 180" role="img"
               aria-label="Car driven by the achieved pack power; the wheels turn with the vehicle speed">
            <line class="car-road" x1="0" y1="159" x2="420" y2="159"></line>
            <path class="car-body" d="M56 142 L52 110 L98 106 L140 74 L266 74 L316 106 L374 116 L380 134 L372 142 Z"></path>
            <path class="car-glass" d="M146 104 L176 82 L206 82 L206 104 Z"></path>
            <path class="car-glass" d="M216 82 L258 82 L292 104 L216 104 Z"></path>
            <rect class="car-lamp" x="49" y="110" width="10" height="12" rx="2"></rect>
            <rect class="car-lamp" x="49" y="126" width="10" height="9" rx="2"></rect>
            <g id="wheel-rear" transform="rotate(0 118 132)">
              <circle class="car-tyre" cx="118" cy="132" r="26"></circle>
              <circle class="car-rim" cx="118" cy="132" r="14"></circle>
              <line class="car-spoke" x1="118" y1="132" x2="118" y2="110"></line>
              <line class="car-spoke" x1="118" y1="132" x2="138.9" y2="125.2"></line>
              <line class="car-spoke" x1="118" y1="132" x2="130.9" y2="149.8"></line>
              <line class="car-spoke" x1="118" y1="132" x2="105.1" y2="149.8"></line>
              <line class="car-spoke" x1="118" y1="132" x2="97.1" y2="125.2"></line>
            </g>
            <g id="wheel-front" transform="rotate(0 318 132)">
              <circle class="car-tyre" cx="318" cy="132" r="26"></circle>
              <circle class="car-rim" cx="318" cy="132" r="14"></circle>
              <line class="car-spoke" x1="318" y1="132" x2="318" y2="110"></line>
              <line class="car-spoke" x1="318" y1="132" x2="338.9" y2="125.2"></line>
              <line class="car-spoke" x1="318" y1="132" x2="330.9" y2="149.8"></line>
              <line class="car-spoke" x1="318" y1="132" x2="305.1" y2="149.8"></line>
              <line class="car-spoke" x1="318" y1="132" x2="297.1" y2="125.2"></line>
            </g>
            <g id="charge-cable" visibility="hidden">
              <rect class="car-plug" x="4" y="112" width="16" height="22" rx="3"></rect>
              <path class="car-cable" d="M20 123 L48 123"></path>
              <rect class="car-flow" id="charge-flow" x="20" y="120" width="0" height="6" rx="3"></rect>
            </g>
          </svg>
        </div>
        <div class="d-flex align-items-baseline justify-content-between mt-2">
          <div><span class="fs-3" id="speed-kph">0</span> <span class="small text-secondary">km/h</span></div>
          <span class="badge text-bg-secondary" id="mode-chip">Coast</span>
        </div>
      </div></div>
    </div>

    <div class="col-12 col-lg-4 order-4 order-lg-3">
      <div class="row g-2">
        <div class="col-6">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-2">
            <h2 class="chart-title">SOC % <span class="chart-scale">&times;1</span></h2>
            <div class="ratio ratio-21x9"><canvas id="chart-soc"></canvas></div>
          </div></div>
        </div>
        <div class="col-6">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-2">
            <h2 class="chart-title">Current A &mdash; + discharge / &minus; charge <span class="chart-scale">&times;1</span></h2>
            <div class="ratio ratio-21x9"><canvas id="chart-current"></canvas></div>
          </div></div>
        </div>
        <div class="col-6">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-2">
            <h2 class="chart-title">Temperature &deg;C &mdash; amber &ge;50, red &ge;60 <span class="chart-scale">&times;1</span></h2>
            <div class="ratio ratio-21x9"><canvas id="chart-temp"></canvas></div>
          </div></div>
        </div>
        <div class="col-6">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-2">
            <h2 class="chart-title">Terminal Voltage V <span class="chart-scale">&times;1</span></h2>
            <div class="ratio ratio-21x9"><canvas id="chart-voltage"></canvas></div>
          </div></div>
        </div>
      </div>
    </div>

    <div class="col-12 order-3 order-lg-4">
      <div class="row g-3 align-items-start">

        <div class="col-6 col-sm-4 col-lg-2">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3 text-center">
            <div class="meas-label mb-2">Accel</div>
            <div class="pedal-track"><input type="range" class="form-range" id="accel-slider" min="0" max="100" step="1" value="0"></div>
            <div class="small text-secondary" id="accel-val">0 %</div>
          </div></div>
        </div>

        <div class="col-6 col-sm-4 col-lg-2">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3 text-center">
            <div class="meas-label mb-2">Brake</div>
            <div class="pedal-track"><input type="range" class="form-range" id="brake-slider" min="0" max="100" step="1" value="0"></div>
            <div class="small text-secondary" id="brake-val">0 %</div>
          </div></div>
        </div>

        <div class="col-12 col-sm-4 col-lg-2">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3">
            <div class="meas-label mb-2">Charge Plug</div>
            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" role="switch" id="plug-toggle">
              <label class="form-check-label small text-secondary" for="plug-toggle">Plugged in</label>
            </div>
            <div class="meas-label mb-2">Charge Rate</div>
            <input type="range" class="form-range" id="charge-slider" min="0" max="250000" step="1000" value="0" disabled>
            <div class="small text-secondary" id="charge-val">0.0 kW</div>
          </div></div>
        </div>

        <div class="col-12 col-sm-6 col-lg-2">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3">
            <div class="meas-label mb-2">Ambient Temperature</div>
            <input type="range" class="form-range" id="ambient-slider" min="-40" max="60" step="1" value="15">
            <div class="small text-secondary" id="ambient-val">15 &deg;C</div>
          </div></div>
        </div>

        <div class="col-6 col-sm-3 col-lg-1">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3 text-center">
            <div class="meas-label mb-2">Chiller</div>
            <div class="knob mx-auto" id="chiller-knob"><div class="knob-marker"></div></div>
            <div class="small text-secondary mt-2" id="chiller-pos">OFF</div>
          </div></div>
        </div>

        <div class="col-6 col-sm-3 col-lg-1">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3 text-center">
            <div class="meas-label mb-2">Heater</div>
            <div class="knob mx-auto" id="heater-knob"><div class="knob-marker"></div></div>
            <div class="small text-secondary mt-2" id="heater-pos">OFF</div>
          </div></div>
        </div>

        <div class="col-12 d-sm-none">
          <div class="card bg-body-tertiary"><div class="card-body p-3">
            <div class="meas-label mb-2">Simulation Speed <span class="speed-badge">&times;1</span></div>
            <input type="range" class="form-range speed-slider" id="speed-bottom" min="1" max="50" step="1" value="1">
          </div></div>
        </div>

      </div>
    </div>

  </div>
</div>
"""
