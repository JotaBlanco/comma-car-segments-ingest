"""The dashboard body: Bootstrap 5.3 grid, the SVG car, and the controls.

Bootstrap owns every layout and breakpoint decision - `row`/`col-*` for the
grid, `order-*` for the phone stacking order (header, car, state, controls,
chart), `d-none d-*-block` for the two elements that collapse, and `ratio` so
the car sizes itself from its column width. All columns live in ONE `row`
because `order-*` only reorders siblings.

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
            <div class="meas-value d-flex align-items-center gap-1" id="temp-cell">
              <span id="temp-value">--- °C</span>
              <svg class="temp-glyph" width="10" height="20" viewBox="0 0 10 20" aria-hidden="true">
                <rect x="3.5" y="1" width="3" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
                <circle cx="5" cy="17" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/>
                <rect x="4.2" y="8" width="1.6" height="6" fill="currentColor"/>
                <circle cx="5" cy="17" r="1.8" fill="currentColor"/>
              </svg>
            </div>
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
          <svg id="car-svg" viewBox="50 50 340 146" role="img"
               aria-label="Car driven by the achieved pack power; the wheels turn with the vehicle speed">
            <!-- The car is a photograph with its background cut away, mirrored to face right and
                 scaled so the photograph's own wheel centres land on the two points the rotation
                 uses: image (1017,487) -> (118,132) and (462,487) -> (318,132), r=76 -> 27.4,
                 scale 0.36036. Each wheel is the SAME photograph clipped to its own wheel circle
                 and carried inside the rotating group, so real rubber turns. -->
            <defs>
              <clipPath id="clip-wheel-rear" clipPathUnits="userSpaceOnUse">
                <circle cx="1017" cy="487" r="76"/>
              </clipPath>
              <clipPath id="clip-wheel-front" clipPathUnits="userSpaceOnUse">
                <circle cx="462" cy="487" r="76"/>
              </clipPath>
            </defs>
            <image href="/static/taycan.png" x="0" y="0" width="1440" height="812"
                   transform="translate(-34.43,-43.49) scale(0.36036) translate(1440,0) scale(-1,1)"/>
            <!-- Over the light bar the photograph already shows, so braking lights the car's
                 own lamp rather than a marker beside it. -->
            <rect class="car-lamp" x="62.5" y="100.4" width="30.5" height="3.6" rx="1.8"/>
            <g id="wheel-rear" transform="rotate(0 118 132)">
              <g transform="translate(-34.43,-43.49) scale(0.36036) translate(1440,0) scale(-1,1)">
                <g clip-path="url(#clip-wheel-rear)">
                  <image href="/static/taycan.png" x="0" y="0" width="1440" height="812"/>
                </g>
              </g>
            </g>
            <g id="wheel-front" transform="rotate(0 318 132)">
              <g transform="translate(-34.43,-43.49) scale(0.36036) translate(1440,0) scale(-1,1)">
                <g clip-path="url(#clip-wheel-front)">
                  <image href="/static/taycan.png" x="0" y="0" width="1440" height="812"/>
                </g>
              </g>
            </g>
            <g id="charge-cable" visibility="hidden">
              <rect class="car-plug" x="4" y="114" width="16" height="20" rx="3"/>
              <path class="car-cable" d="M20 124 L56 124"/>
              <rect class="car-flow" id="charge-flow" x="20" y="121" width="0" height="6" rx="3"/>
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
      <div class="card bg-body-tertiary h-100"><div class="card-body p-2 d-flex flex-column gap-2">
        <div class="d-flex align-items-center justify-content-between flex-wrap gap-1">
          <ul class="nav nav-pills chart-tabs" id="chart-tabs">
            <li class="nav-item"><button class="nav-link active" data-series="soc">SOC %</button></li>
            <li class="nav-item"><button class="nav-link" data-series="current">Current A</button></li>
            <li class="nav-item"><button class="nav-link" data-series="temp">Temperature &deg;C</button></li>
            <li class="nav-item"><button class="nav-link" data-series="voltage">Voltage V</button></li>
          </ul>
          <span class="badge text-bg-secondary chart-scale">&times;1</span>
        </div>
        <div class="flex-grow-1 position-relative" style="min-height:0">
          <canvas id="chart-main" style="display:block;width:100%;height:100%"></canvas>
        </div>
      </div></div>
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
            <div class="knob-wrap mx-auto">
              <span class="knob-label knob-label-off" data-pos="0">OFF</span>
              <span class="knob-label knob-label-mid" data-pos="1">1</span>
              <span class="knob-label knob-label-on" data-pos="2">2</span>
              <div class="knob" id="chiller-knob"><div class="knob-marker"></div></div>
            </div>
            <div class="small text-secondary mt-2" id="chiller-pos">OFF</div>
          </div></div>
        </div>

        <div class="col-6 col-sm-3 col-lg-1">
          <div class="card bg-body-tertiary h-100"><div class="card-body p-3 text-center">
            <div class="meas-label mb-2">Heater</div>
            <div class="knob-wrap mx-auto">
              <span class="knob-label knob-label-off" data-pos="0">OFF</span>
              <span class="knob-label knob-label-mid" data-pos="1">1</span>
              <span class="knob-label knob-label-on" data-pos="2">2</span>
              <div class="knob" id="heater-knob"><div class="knob-marker"></div></div>
            </div>
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
