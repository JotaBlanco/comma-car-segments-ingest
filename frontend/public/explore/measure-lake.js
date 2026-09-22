// ── Measurement view: QuixLake provider ─────────────────────
// The real provider. Satisfies the same contract as the synthetic one in
// measure-demo.js, but answers every call from QuixLab's own /api/lake/*
// routes, so it works wherever the platform injects a lake endpoint.
//
// Nothing here is demo-dependent: the dataset node mounts this by default.
// measure-demo.js is opt-in for frontend work with no lake reachable
// (see MeasureLake.pick).
//
// One shape, whatever the table: the deepest partition value IS the channel, so
// a signal id is a pure partition path ("platform=FORD/signal=EngineSpeed") and
// the value column comes from the columns panel, never from the tree. A
// trailing bare segment is still parsed as a column, because a layout saved by
// an older build carries one and the view's fan-out keys append one.
//
// Aggregation happens in SQL, not the browser: one row per bucket carries
// min/max/sum/count, so raw samples never cross the wire and zooming
// re-queries at the new resolution instead of caching a raw series.

(function () {
  "use strict";

  /** The bucket ceiling: one bucket per CSS pixel, up to a 4K-wide plot.
   *
   *  It guards browser memory, not the lake — ``GROUP BY qb`` already bounds
   *  the row count, and frames pass ``maxRows: 0`` so /api/lake/preview does
   *  not cap them either. measure-view.js owns the number and shares it on
   *  window.QM, read at call time the way columnRank is.
   */
  function maxBuckets() {
    return (window.QM && window.QM.BUCKET_MAX) || 4096;
  }

  // Numeric in both vocabularies: DuckDB's (BIGINT) and the catalog's (long, int32), never INTERVAL.
  const NUMERIC =
    /^\s*(?:U?(?:BIG|SMALL|TINY|HUGE)?INT(?:EGER)?|LONG|SHORT|BYTE|FLOAT|DOUBLE|REAL|DEC(?:IMAL)?|NUMERIC)(?![A-Z_])/i;
  const TIMEISH = /TIMESTAMP|DATETIME|DATE/i;
  // Names that plausibly carry time. Used only as a last resort, and it
  // deliberately includes the partition-style ones (date/day/hour/…) because a
  // table partitioned by date keeps its only time reference there.
  const TIME_NAME =
    /(^|_)(t|ts|time|timestamp|date|datetime|day|hour|minute|epoch|millis?|ms|us|ns)(_|$)/i;
  // Columns that carry time or bookkeeping rather than a measurement.
  const NOT_A_SIGNAL =
    /^(__|_)|^(t_abs_ms|t_rel_ms|ts_ms|ts|timestamp|time|date|datetime)$/i;

  // Integer time-column candidates, MOST preferred first. Order matters and
  // must not be replaced by a regex match against the column list: a table
  // can carry several, and picking whichever happens to appear first in the
  // schema lands on the wrong one. Observed case — a table with both
  // "Timestamp" (raw ns counter, file-local, partly junk) and "ts_ms": column
  // order put Timestamp first, which put the data decades away from the data.
  //
  // ``ms: true`` means the name declares milliseconds, so no probe is needed.
  // t_abs_ms is the lake's canonical absolute-time column and always wins.
  const PREFERRED_TIME = [
    { name: "t_abs_ms", ms: true },
    { name: "ts_ms", ms: true },
    { name: "timestamp", ms: false },
    { name: "ts", ms: false },
    { name: "time", ms: false },
  ];

  // Sub-millisecond clocks, FINEST first, with their multiplier to milliseconds.
  const SUB_MS_TIME = [
    { re: /(^|_)(t|ts|time|timestamp|stamp|epoch|clock)_(ns|nanos(ec(onds?)?)?)$/i,
      scale: 1 / 1e6 },
    { re: /(^|_)(t|ts|time|timestamp|stamp|epoch|clock)_(us|usec|micros(ec(onds?)?)?)$/i,
      scale: 1 / 1000 },
  ];

  /** The finest sub-millisecond time column a schema declares by name, or null.
   *
   *  A bare integer clock carries no unit and nothing probes for one (see
   *  loadSchema), so the NAME is the only honest source. The time STEM is
   *  required: a column called just "us" or "ns" is a reading labelled by its
   *  unit rather than a clock — the case COL_UNIT_ONLY exempts in
   *  measure-view.js — and "delta_us" is a duration, not a time base.
   *
   *  loadSchema asks this AFTER its name cascade and only for an integer
   *  clock: a genuine TIMESTAMP column already carries its unit in its type,
   *  so trading it for a bare counter would swap a fact for a guess.
   */
  function finestSubMs(cols) {
    for (const u of SUB_MS_TIME) {
      const hit = (cols || []).find(function (c) {
        return u.re.test(String(c.name)) && NUMERIC.test(c.type || "");
      });
      if (hit) return { name: hit.name, scale: u.scale };
    }
    return null;
  }

  // The table list is cached in localStorage, not sessionStorage, and warmed
  // on page load. /api/lake/tables cannot be made fast from here: with
  // per-user scoping the catalog resolves every table's location to check read
  // access, so it scales with the catalog and on a large one takes tens of
  // seconds. The only way to show a list in a second is to already have it, so
  // it is fetched once in the background and kept across reloads.
  const TABLES_KEY = "qm.tables.v1";
  const TABLES_TTL_MS = 60 * 60 * 1000;

  // Metadata call log. Separate from QUERY_LOG because these are a different
  // animal: no SQL, no scan, and they are what the sidebar is made of. Without
  // timings here a slow tree could only be diagnosed by taking a HAR — which is
  // how the last routing mistake was found, far too late.
  //
  //   MeasureLake.meta()        -> the last 50 metadata calls, newest last
  //   MeasureLake.slowMeta(ms)  -> only the ones over a threshold (default 500ms)
  //   MeasureLake.levels()      -> per tree level: which route answered, how long
  const META_LOG = [];
  const META_LOG_MAX = 50;
  const LEVEL_LOG = [];
  const LEVEL_LOG_MAX = 50;

  function jget(url) {
    const started = Date.now();
    const entry = { url: url, ms: null, error: null };
    META_LOG.push(entry);
    if (META_LOG.length > META_LOG_MAX) META_LOG.shift();
    // Test Manager: the viewer's token rides as a header, not a cookie.
    const tmHeaders = window.__tmLakeHeaders ? window.__tmLakeHeaders() : {};
    return fetch(url, { credentials: "same-origin", headers: tmHeaders }).then(function (r) {
      // Not an answer: an error body parses as JSON with no fields, reading as empty.
      if (r.status >= 400) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    }).then(function (d) {
      entry.ms = Date.now() - started;
      entry.error = (d && d.error) ? String(d.error) : null;
      if (debugOn() && window.console) {
        console.log("[measure] meta " + entry.ms + "ms " + url +
          (entry.error ? " ERROR: " + entry.error : ""));
      }
      return d;
    }, function (e) {
      entry.ms = Date.now() - started;
      entry.error = String((e && e.message) || e);
      throw e;
    });
  }

  /** Record which route answered a tree level, and how long the whole level took.
   *
   *  ``route`` is the one that produced the nodes: "partitions" is the fast
   *  primary, and anything else means the primary could not answer and the
   *  fallback chain ran — one refusal plus a manifest call, which is what a slow
   *  virtual level actually looks like from here.
   */
  function noteLevel(path, route, ms, count, err) {
    LEVEL_LOG.push({
      path: path || "(root)", route: route, ms: ms, nodes: count,
      error: err ? String((err && err.message) || err) : null,
    });
    if (LEVEL_LOG.length > LEVEL_LOG_MAX) LEVEL_LOG.shift();
    if (window.console && (ms > 1500 || route !== "partitions")) {
      console.warn("[measure] level " + (path || "(root)") + " answered by " +
        route + " in " + ms + "ms (" + count + " nodes)" +
        (route !== "partitions" ? " — the primary route did not answer" : ""));
    }
  }

  /** Cached table names, or null. Stale entries are still returned — a list
   *  from an hour ago beats an empty panel — the caller refreshes behind it. */
  function cachedTables() {
    try {
      const o = JSON.parse(localStorage.getItem(TABLES_KEY) || "null");
      if (!o || !Array.isArray(o.tables) || !o.tables.length) return null;
      return { tables: o.tables, stale: (Date.now() - (o.at || 0)) > TABLES_TTL_MS };
    } catch (e) { return null; }
  }

  let inflightTables = null;
  let warnedSlowPartitions = false;

  /** Fetch the table list and remember it. Shared: concurrent callers (the
   *  page-load warm-up and an eager user) must not both pay for it. */
  function fetchTables() {
    if (inflightTables) return inflightTables;
    inflightTables = jget("/api/lake/tables?include_metadata=false")
      .then(function (d) {
        if (d && d.error) throw new Error(d.error);
        const list = ((d && d.tables) || []).map(function (t) {
          return typeof t === "string"
            ? { name: t }
            : { name: t.name, partitions: t.file_count, rows: t.rows || "" };
        });
        if (list.length) {
          try {
            localStorage.setItem(TABLES_KEY,
              JSON.stringify({ at: Date.now(), tables: list }));
          } catch (e) { /* full or private — the in-memory copy still serves */ }
        }
        return list;
      })
      .catch(function (e) { inflightTables = null; throw e; })
      .then(function (list) { inflightTables = null; return list; });
    return inflightTables;
  }

  /** Fetch the table list into the cache, off the critical path.
   *
   *  NOT called automatically, and that is deliberate. include_metadata=false
   *  does not make /tables cheap: the lake still runs its per-user access
   *  filter, which resolves EVERY table's location one at a time, and its logs
   *  put each of those at 1.3-5s ("SLOW GET /namespaces/default/tables/<name>").
   *  So a single /tables call costs the shared service an entire enumeration —
   *  into a pool of ten connections, while a compaction job is also using it.
   *
   *  Paying that on every page load, for every user, to save a wait that most of
   *  them will never reach, is the wrong trade. The measurement view opens on
   *  the dataset node's OWN table and needs no enumeration at all; the list is
   *  fetched when someone actually opens the picker, and cached from then on.
   *
   *  Exposed so it can be triggered deliberately: MeasureLake.warmTables().
   */
  function warmTables() {
    if (cachedTables()) return Promise.resolve(null);
    return fetchTables().catch(function () { /* retried when the picker opens */ });
  }

  // ── query log ─────────────────────────────────────────────
  // Every SQL this provider sends, with how long it took and what came back.
  // An empty plot is otherwise impossible to tell apart from a bad query, and
  // the answer is always "look at the SQL" — so keep it to hand:
  //
  //   MeasureLake.queries()   -> the last 50, newest last
  //   MeasureLake.lastQuery() -> just the most recent
  //   copy(MeasureLake.lastQuery().sql)   to run it yourself
  //
  // Add ?qmDebug=1 (or window.QM_DEBUG = true) to also log each one live.
  const QUERY_LOG = [];
  const QUERY_LOG_MAX = 50;

  // Tree levels, cached for the page rather than for one view instance. Closing
  // the measurement view and opening it again is a normal thing to do, and it
  // should not re-walk levels that have not changed — especially the virtual
  // ones, which are slow in every client (the lakehouse's own UI included). The
  // key carries the table, so entries never collide across tables.
  const levelCache = {};                 // "lvl|table|path" -> nodes
  const levelInflight = {};              // same key -> in-flight promise

  function debugOn() {
    if (window.QM_DEBUG) return true;
    try {
      return new URLSearchParams(window.location.search).get("qmDebug") === "1";
    } catch (e) { return false; }
  }

  // ── concurrency cap ───────────────────────────────────────
  // The lake shares ONE connection pool for the whole deployment, and its logs
  // show it saturating: "Connection pool is full, discarding connection:
  // lh-cat-…  Connection pool size: 10". Fanning six windows' queries out at
  // once does not make them finish sooner — it evicts other people's
  // connections and our own, so requests queue inside the lake where we cannot
  // see them, or get dropped and retried.
  //
  // Queue here instead, where it is visible and ordered.
  //
  // ONE at a time, not four. Everything in this lane is a bucketed aggregate over
  // a partition, and the lake cannot prune files by the time predicate today (no
  // per-file zone maps yet), so each query decodes the whole pinned partition —
  // four of those resident at once multiplied the query service's peak memory by
  // four and was reported as the service eating RAM. Running them concurrently
  // never made them finish sooner either: they share the same saturated
  // 10-connection pool, so the parallelism was only ever nominal.
  //
  // This lane is the /api/lake/preview route alone (frames and extent). Metadata
  // calls go through jget and are deliberately NOT queued: /schema, /partitions
  // and /partition-info answer in tens of milliseconds and are what makes the tree
  // feel alive, so they must never wait behind a scan.
  // Per-LANE caps, not one global queue. Narrowing everything to a single slot
  // fixed the memory but created a queue where a cheap query waited behind an
  // expensive one: `extent` (what fit uses, ORDER BY … LIMIT 1, ~1.4s) could sit
  // behind a frames scan for up to the 45s timeout, and a superseded pan held the
  // only slot while its answer was already being thrown away. Both read as "it got
  // slow again", and both were mine.
  //
  // One frames scan at a time — that is the memory ceiling and it stays. But
  // extent gets its own slot, so navigating never waits on a scan it does not need.
  const LANE_CAP = { frames: 1, extent: 1, units: 1, "": 1 };
  const MAX_INFLIGHT = 2;
  const waiting = [];
  const active = new Set();

  const SUPERSEDED = "superseded";

  function laneCount(tag) {
    let n = 0;
    active.forEach(function (j) { if (j.tag === tag) n++; });
    return n;
  }

  /** Drop work whose answer is already known to be stale.
   *
   *  A newer generation of the same lane makes every older one pointless: the view
   *  discards their results anyway (it compares against its own fetch generation),
   *  so holding a slot for them only delays the query the user is waiting for.
   *  Queued ones never start; in-flight ones are aborted, which frees the slot
   *  immediately. Note the lake keeps working on an aborted request — the QuixLab
   *  route is a blocking `requests` call — so this buys back OUR slot, not the
   *  service's. Not issuing redundant queries is still the only thing that saves
   *  the service work.
   */
  function supersede(tag, gen) {
    if (!tag || !gen) return;
    for (let i = waiting.length - 1; i >= 0; i--) {
      const j = waiting[i];
      if (j.tag === tag && j.gen && j.gen < gen) {
        waiting.splice(i, 1);
        j.reject(new Error(SUPERSEDED));
      }
    }
    active.forEach(function (j) {
      if (j.tag === tag && j.gen && j.gen < gen && j.abort) j.abort();
    });
  }

  function pump() {
    // Walk in order and start the first job whose lane has room — skipping a
    // blocked lane rather than stalling behind it is the whole point.
    while (active.size < MAX_INFLIGHT) {
      let idx = -1;
      for (let i = 0; i < waiting.length; i++) {
        const tag = waiting[i].tag;
        if (laneCount(tag) < (LANE_CAP[tag] == null ? 1 : LANE_CAP[tag])) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      const job = waiting.splice(idx, 1)[0];
      active.add(job);
      job.run(job).then(job.resolve, job.reject).then(function () {
        active.delete(job);
        pump();
      });
    }
  }

  /** Run ``fn`` once its lane has a slot. FIFO within a lane.
   *
   *  ``meta.tag`` picks the lane; ``meta.gen`` lets a newer call of the same lane
   *  supersede older ones (see supersede).
   */
  function queued(fn, meta) {
    meta = meta || {};
    return new Promise(function (resolve, reject) {
      const job = {
        run: fn, resolve: resolve, reject: reject,
        tag: meta.tag || "", gen: meta.gen || 0, abort: null,
      };
      supersede(job.tag, job.gen);
      waiting.push(job);
      pump();
    });
  }

  // A slot must always come back. The lake can take minutes to answer or never
  // answer at all, and with a fixed number of slots a hung request does not just
  // fail itself — it blocks every query behind it, so the view stops updating
  // and looks wedged. Give up the slot and report it instead.
  const QUERY_TIMEOUT_MS = 45000;

  /** Run SQL through the preview route and hand back plain rows.
   *
   *  ``meta`` is optional: {tag, gen} to pick the lane and allow superseding,
   *  and {maxRows} for the route's row cap — 0 means uncapped, for a query
   *  that bounds its own rows. Omitted leaves the route's 1000-row default.
   */
  function sql(query, meta) {
    return queued(function (job) {
      let timer = null;
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      if (job) job.abort = function () { if (ctl) ctl.abort(); };
      const guard = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          if (ctl) ctl.abort();
          reject(new Error("query gave up after " + (QUERY_TIMEOUT_MS / 1000) +
            "s — the lake did not answer"));
        }, QUERY_TIMEOUT_MS);
      });
      // Whichever settles first frees the slot; a late reply is simply ignored.
      return Promise.race([sqlNow(query, ctl, meta && meta.maxRows), guard]).then(
        function (rows) { clearTimeout(timer); return rows; },
        function (e) { clearTimeout(timer); throw e; }
      );
    }, meta);
  }

  function sqlNow(query, ctl, maxRows) {
    const started = Date.now();
    const entry = { sql: query, ms: null, rows: null, error: null };
    QUERY_LOG.push(entry);
    if (QUERY_LOG.length > QUERY_LOG_MAX) QUERY_LOG.shift();

    const payload = { query: query };
    // Only sent when asked for; without the key the route keeps its own row cap.
    if (typeof maxRows === "number") payload.max_rows = maxRows;

    return fetch("/api/lake/preview", {
      method: "POST",
      credentials: "same-origin",
      // Test Manager: the viewer's token rides as a header, not a cookie.
      headers: Object.assign({ "Content-Type": "application/json" },
        window.__tmLakeHeaders ? window.__tmLakeHeaders() : {}),
      body: JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined,
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        entry.ms = Date.now() - started;
        if (d && d.error) {
          entry.error = String(d.error);
          if (window.console) console.warn("[measure] query FAILED in " + entry.ms +
            "ms: " + entry.error + "\n" + query);
          throw new Error(d.error);
        }
        const rows = (d && d.rows) || [];
        entry.rows = rows.length;
        entry.columns = (d && d.columns) || null;
        if (debugOn() && window.console) {
          console.log("[measure] " + entry.ms + "ms, " + rows.length + " rows\n" + query);
        }
        return rows;
      })
      .catch(function (e) {
        entry.ms = entry.ms == null ? Date.now() - started : entry.ms;
        if (!entry.error) entry.error = String((e && e.message) || e);
        throw e;
      });
  }

  // ── SQL literals ──────────────────────────────────────────
  // Identifiers and values both arrive from lake metadata or user picks, so
  // both get quoted rather than interpolated raw.
  const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

  // The lake's folder name for a partition bucket whose column has no value.
  const NULL_PLACEHOLDER = "__None__";

  // One partition filter; twin of js/partition-where.js, which a classic script cannot import.
  const partitionPredicate = (col, val) => {
    // The NULL bucket must match real NULLs and the placeholder folder: `col = '__None__'` breaks on numeric columns.
    if (String(val) === NULL_PLACEHOLDER) {
      return "(" + ident(col) + " IS NULL OR CAST(" + ident(col) + " AS VARCHAR) = " +
        lit(NULL_PLACEHOLDER) + ")";
    }
    return ident(col) + " = " + lit(val);
  };

  /** The one value in a single-column row, whatever the engine called it. */
  function firstValue(row) {
    if (row == null) return null;
    if (row.t !== undefined) return row.t;
    const k = Object.keys(row)[0];
    return k === undefined ? null : row[k];
  }

  // The whole-table channel's reserved segment; measure-view.js owns the grammar.
  const WHOLE_TABLE = (window.QM && window.QM.WHOLE_TABLE) || "~all";

  /** Split a signal id into its partition filters and (maybe) a column.
   *
   *  A selected channel is a pure partition path: "platform=FORD/signal=X" ->
   *  filters [platform=FORD, signal=X] and NO column, because what to aggregate
   *  comes from the columns panel. Treating the trailing "signal=X" as a column
   *  name was the bug: it dropped that filter, so every signal in the table was
   *  aggregated together.
   *
   *  A trailing BARE segment is still a column ("…/day=13/GS" -> column GS).
   *  Two things produce one: a layout saved when columns were tree leaves, and
   *  the view's per-column trace keys (tracesOf), which append the column to the
   *  signal id so all N traces keep one partition prefix.
   *
   *  The one exception is the whole-table channel ("~all", and "~all/GS" once it
   *  fans out): it filters nothing and names no column, so it parses to an empty
   *  WHERE and whereSql emits the time predicate alone.
   */
  function parseId(id) {
    const segs = String(id).split("/").filter(Boolean);
    const where = [];
    let column = null;
    segs.forEach(function (s) {
      if (s === WHOLE_TABLE) return;      // the whole table: no filter, no column
      const i = s.indexOf("=");
      if (i > 0) where.push({ col: s.slice(0, i), val: s.slice(i + 1) });
      else column = s;                    // a bare segment is a column name
    });
    return {
      column: column,
      where: where,
      // Scope for grouping queries: everything except a trailing column.
      prefix: segs.filter(function (s) { return s.indexOf("=") > 0; }).join("/"),
      // Display name: the deepest partition value, or the column.
      label: column || (where.length ? where[where.length - 1].val : String(id)),
    };
  }

  /** Epoch multiplier -> milliseconds, inferred from magnitude.
   *
   *  A bare integer time column carries no unit, and getting this wrong puts
   *  the data centuries away from the cursor. Thresholds sit between the
   *  plausible ranges for a present-day timestamp in each unit.
   */
  function epochScale(maxValue) {
    const v = Math.abs(Number(maxValue) || 0);
    if (v < 1e11) return 1000;          // seconds
    if (v < 1e14) return 1;             // milliseconds
    if (v < 1e17) return 1 / 1000;      // microseconds
    return 1 / 1e6;                     // nanoseconds
  }

  /** Build the provider.
   *
   *  ``table`` may be a name or a getter. The view owns ONE provider for its
   *  whole lifetime and switches tables underneath it (setTable mutates
   *  state.table), so the active table is resolved per call and every cache
   *  is keyed by it — a table fixed at construction would keep answering the
   *  old table's schema after a switch.
   */
  function makeProvider(table) {
    const T = typeof table === "function"
      ? function () { return table() || ""; }
      : function () { return table || ""; };

    const cache = {};                    // table -> {schema, partCols, bounds, ...}
    const extentCache = {};              // query key -> {at, value}
    const extentInflight = {};           // query key -> in-flight promise
    const EXTENT_TTL_MS = 5 * 60 * 1000;
    let tablesPromise = null;            // the table list, fetched at most once
    function box() {
      const k = T();
      return (cache[k] = cache[k] || {
        schema: null, partCols: null, bounds: null,
        // In-flight promises, so CONCURRENT callers share one request. Caching
        // only the result is not enough: children() resolves the schema and the
        // partition columns together, and several tree levels can ask at once,
        // which fetched the same metadata two or three times over.
        schemaP: null, partColsP: null,
      });
    }

    /** Millisecond expression for the time column, or null if there is none.
     *
     *  ``xOverride`` is the X column the user chose in the columns panel. It
     *  wins over detection: naming the time column is the whole point of that
     *  picker, and on a table whose time column is not conventionally named it
     *  is the only way to plot at all.
     */
    function tsMs(schema, xOverride) {
      let col = schema.timeCol;
      let stamp = schema.timeIsStamp;
      let scale = schema.scale;
      if (xOverride && xOverride !== col) {
        const c = schema.columns.find(function (x) { return x.name === xOverride; });
        if (c) {
          col = c.name;
          stamp = TIMEISH.test(c.type || "");
          // Same unit rule as detection: a name declaring µs or ns is honoured,
          // anything else is assumed milliseconds — no probe, per the no-scans rule.
          const declared = finestSubMs([c]);
          scale = declared ? declared.scale : 1;
        }
      }
      if (!col) return null;
      if (stamp) return "epoch_ms(" + ident(col) + ")";
      const cast = "CAST(" + ident(col) + " AS DOUBLE)";
      if (scale === 1) return cast;
      return scale >= 1
        ? "(" + cast + " * " + scale + ")"
        : "(" + cast + " / " + (1 / scale) + ")";
    }

    /** The X column shared by a request's signals, if the user set one. */
    function xOf(q) {
      if (!q || !q.cols) return null;
      const ids = Object.keys(q.cols);
      for (let i = 0; i < ids.length; i++) {
        const x = q.cols[ids[i]] && q.cols[ids[i]].x;
        if (x) return x;
      }
      return null;
    }

    const NO_TIME = "No time column on this table — pick one as X in the " +
      "columns panel.";

    function whereSql(ts, pairs, t0, t1) {
      const parts = (pairs || []).map(function (p) {
        return partitionPredicate(p.col, p.val);
      });
      if (ts && t0 != null) parts.push(ts + " >= " + t0);
      if (ts && t1 != null) parts.push(ts + " < " + t1);
      return parts.length ? " WHERE " + parts.join(" AND ") : "";
    }

    /** Load schema once per table: columns, the time column, and its unit. */
    function loadSchema() {
      const b = box();
      const tbl = T();
      if (b.schema) return Promise.resolve(b.schema);
      if (!tbl) return Promise.reject(new Error("no table selected"));
      if (b.schemaP) return b.schemaP;
      b.schemaP = jget("/api/lake/schema?table=" + encodeURIComponent(tbl))
        .then(function (d) {
          const cols = (d && d.columns) || [];
          if (!cols.length) {
            throw new Error((d && d.error) || "table has no columns");
          }
          const byName = function (want) {
            return cols.find(function (c) {
              return String(c.name).toLowerCase() === want;
            });
          };

          let timeCol = null;
          let stamp = false;      // a real TIMESTAMP type — no unit to infer
          let known = false;      // unit known from the name — no probe needed
          let scale = 1;          // multiplier to milliseconds

          // 1. t_abs_ms, the canonical absolute-time column.
          const abs = byName("t_abs_ms");
          if (abs) {
            timeCol = abs.name;
            stamp = TIMEISH.test(abs.type || "");
            known = !stamp;
          }
          // 2. Whatever the catalog itself names.
          if (!timeCol && d.timestamp_column) {
            timeCol = d.timestamp_column;
            const c = cols.find(function (x) { return x.name === timeCol; });
            stamp = !!(c && TIMEISH.test(c.type || ""));
          }
          // 3. A genuine timestamp type.
          if (!timeCol) {
            const t = cols.find(function (c) { return TIMEISH.test(c.type || ""); });
            if (t) { timeCol = t.name; stamp = true; }
          }
          // 4. Remaining conventional names, in preference order.
          if (!timeCol) {
            for (const cand of PREFERRED_TIME) {
              const hit = byName(cand.name);
              if (!hit || !NUMERIC.test(hit.type || "")) continue;
              timeCol = hit.name;
              known = cand.ms;
              break;
            }
          }
          // 5. Last resort: a time-ish NAME on any usable type. A table
          // partitioned by date/day/hour keeps its only time reference in the
          // partition column — which appears here as a column too.
          if (!timeCol) {
            const loose = cols.find(function (c) {
              return TIME_NAME.test(String(c.name)) &&
                (NUMERIC.test(c.type || "") || TIMEISH.test(c.type || ""));
            });
            if (loose) {
              timeCol = loose.name;
              stamp = TIMEISH.test(loose.type || "");
            }
          }
          // 6. Resolution beats convention — see finestSubMs, which says why.
          if (!stamp) {
            const finer = finestSubMs(cols);
            if (finer) { timeCol = finer.name; scale = finer.scale; }
          }
          // Still nothing is NOT an error. The tree, the schema and the column
          // picker all remain useful, and the user can name the time column as
          // X — which is exactly what that picker is for. Throwing here took the
          // whole view down, browsing included, for a table that simply does
          // not advertise its time column.
          if (!timeCol && window.console) {
            console.info("[measure] no time column detected on " + tbl +
              " — pick one as X in the columns panel.");
          }

          const schema = {
            columns: cols, timeCol: timeCol, timeIsStamp: stamp, scale: scale,
          };
          cache[tbl].schema = schema;
          // No aggregate probe to infer the unit. max() over a billion-row
          // table costs a full column scan, and it ran before the tree could
          // even be drawn — the view sat "loading" on a query the user never
          // asked for. A real TIMESTAMP carries its own unit, t_abs_ms is
          // milliseconds by contract, and a name ending in _us / _ns declares
          // its own (step 6); anything else is ASSUMED milliseconds, which is
          // the overwhelmingly common encoding. For a column that is seconds
          // and does not say so, the fix is to expose the unit as metadata, or
          // to rename it — not to scan for it.
          return schema;
        }).catch(function (e) {
          b.schemaP = null;            // a failure must be retryable
          throw e;
        });
      return b.schemaP;
    }

    /** Partition columns of the active table, or a rejection carrying the
     *  lake's own reason.
     *
     *  An EMPTY list and a FAILED listing are different answers and must not
     *  be conflated. Empty is normal (an unpartitioned table, or an older
     *  catalog) and means "signals straight off the schema"; a failure means
     *  the structure is unknown. Returning [] for both turned a 403 on a
     *  six-level table into one whole-table channel named after the table —
     *  a confident wrong answer where the refusal belonged. Note the route
     *  reports its failure as HTTP 200 plus an ``error`` field, so that field
     *  is the failure, not a detail. Only a success is cached, so a transient
     *  failure retries on the next call.
     */
    function loadPartCols() {
      const b = box();
      const tbl = T();
      if (b.partCols) return Promise.resolve(b.partCols);
      if (!tbl) return Promise.reject(new Error("no table selected"));
      if (b.partColsP) return b.partColsP;
      b.partColsP = jget("/api/lake/partition-info?table=" + encodeURIComponent(tbl))
        .then(function (d) {
          if (d && d.error) throw new Error(d.error);
          b.partCols = (d && d.partition_columns) || [];
          return b.partCols;
        })
        .catch(function (e) {
          b.partColsP = null;          // a failure must be retryable
          throw e;
        });
      return b.partColsP;
    }

    /** Numeric columns that read as measurements. */
    function signalColumns(schema, partCols) {
      return schema.columns.filter(function (c) {
        return NUMERIC.test(c.type || "") &&
          c.name !== schema.timeCol &&
          !NOT_A_SIGNAL.test(c.name) &&
          (partCols || []).indexOf(c.name) < 0;
      }).map(function (c) { return c.name; });
    }

    /** Manifest fallback for one level, used only when /partitions cannot list
     *  it (an older catalog). Tries the single-column distinct first, then the
     *  combination index, which is the only one of the two that can answer for a
     *  virtual column. Neither is on the fast path any more — see children().
     */
    function distinctChildren(path, col, leafLevel) {
      const where = {};
      String(path || "").split("/").filter(Boolean).forEach(function (seg) {
        const i = seg.indexOf("=");
        if (i > 0) where[seg.slice(0, i)] = seg.slice(i + 1);
      });
      const q = "/api/lake/partition-values?table=" + encodeURIComponent(T()) +
        "&column=" + encodeURIComponent(col) +
        (Object.keys(where).length
          ? "&where=" + encodeURIComponent(JSON.stringify(where)) : "");

      return jget(q).then(function (d) {
        if (d && d.error) throw new Error(d.error);
        const vals = (d && d.values) || [];
        if (!vals.length) throw new Error("no values for " + col);
        return vals.map(function (v) {
          const val = String(v);
          return {
            key: col, value: val, leaf: !!leafLevel, kind: "physical",
            seg: col + "=" + val,
            meta: leafLevel ? { name: val, unit: "", dec: 3 } : undefined,
          };
        });
      }).catch(function () {
        return combinationChildren(path, col, leafLevel);
      });
    }

    /** One level from the catalog's partition-combination index.
     *
     *  This is the route that serves a VIRTUAL partition column. Virtual levels
     *  are a per-file value index rather than directories, so the single-column
     *  distinct query rejects them — and the only other option is walking the
     *  directory tree one prefix at a time, which is why a virtual level took
     *  far longer than the physical ones above it.
     *
     *  The reply's exact shape belongs to the upstream catalog, so the target
     *  column's values are extracted defensively rather than assumed.
     */
    function combinationChildren(path, col, leafLevel) {
      const where = {};
      String(path || "").split("/").filter(Boolean).forEach(function (s) {
        const i = s.indexOf("=");
        if (i > 0) where[s.slice(0, i)] = s.slice(i + 1);
      });
      const q = "/api/lake/partition-combinations?table=" + encodeURIComponent(T()) +
        "&limit=1000" +
        (Object.keys(where).length
          ? "&where=" + encodeURIComponent(JSON.stringify(where)) : "");

      return jget(q).then(function (d) {
        if (!d || d.error) throw new Error((d && d.error) || "no combinations");
        // Accept a bare array, or an array under any of the plausible keys.
        let rows = null;
        if (Array.isArray(d)) rows = d;
        else {
          ["combinations", "values", "rows", "partitions", "items"].some(function (k) {
            if (Array.isArray(d[k])) { rows = d[k]; return true; }
            return false;
          });
        }
        if (!rows) throw new Error("unrecognised combinations payload");

        const seen = Object.create(null);
        const vals = [];
        rows.forEach(function (r) {
          let v = null;
          if (r == null) return;
          if (typeof r === "string" || typeof r === "number") v = r;
          else if (r[col] != null) v = r[col];
          else if (r.value != null && (r.column === col || r.key === col)) v = r.value;
          if (v == null) return;
          // The innermost key can be aggregated into a list per outer row.
          (Array.isArray(v) ? v : [v]).forEach(function (one) {
            const str = String(one);
            if (!str || seen[str]) return;
            seen[str] = true;
            vals.push(str);
          });
        });
        if (!vals.length) throw new Error("no values for " + col);
        vals.sort();
        return vals.map(function (val) {
          return {
            // Reached only because /partition-values refused this column, and
            // that refusal is exactly what identifies it as virtual.
            key: col, value: val, leaf: leafLevel, kind: "virtual",
            seg: col + "=" + val,
            meta: leafLevel ? { name: val, unit: "", dec: 3 } : undefined,
          };
        });
      });
    }

    /** Directory-listing fallback for one tree level.
     *
     *  Used only when the manifest route cannot answer: it costs one call per
     *  parent prefix instead of one per level, and it is the older catalogs'
     *  only option. Carries file counts, which the manifest route does not.
     */
    function listChildren(path, col) {
      const q = "/api/lake/partitions?table=" + encodeURIComponent(T()) +
        "&path=" + encodeURIComponent(path || "") + "&include_sizes=true";
      return jget(q).then(function (d) {
        if (d && d.error) throw new Error(d.error);
        return ((d && d.partitions) || []).map(function (p) {
          const raw = String(p.name || "");
          const i = raw.indexOf("=");
          const key = i < 0 ? col : raw.slice(0, i);
          const val = i < 0 ? raw : raw.slice(i + 1);
          // The catalog states all of this; none of it needs inferring.
          // has_children marks the deepest partition level, and `virtual` is
          // what the lakehouse's own UI uses to pick its folder icon.
          const deepest = p.has_children === false;
          return {
            key: key, value: val,
            // The deepest partition value IS the channel, so nothing follows it.
            leaf: deepest,
            kind: p.virtual ? "virtual" : "physical",
            count: p.file_count,
            seg: i < 0 ? key + "=" + raw : raw,
            meta: deepest ? { name: val, unit: "", dec: 3 } : undefined,
          };
        });
      });
    }

    /** How likely a column is to hold a reading: 0 best, 40 worst.
     *
     *  Delegates to THE shared heuristic (measure-view.js columnRank, which
     *  loads first), so the seeded default is the columns panel's own first row
     *  rather than whatever the catalog happens to list first. Every candidate
     *  here is already known numeric, hence the fixed type.
     */
    function yRank(name) {
      return window.QM.columnRank(name, "numeric");
    }

    /** The column to seed as the table's value default.
     *
     *  Never returns null when there is any candidate at all. Giving up unless
     *  a column was literally named "value" left the Y default unset, which
     *  meant the query had nothing to aggregate ("no data") while the panel
     *  displayed the first option as though it were selected.
     *
     *  Schema order alone is not good enough either: where the first numeric
     *  columns were "file_timestamp_epoch_ms" and "fileSizeBytes" a fresh node
     *  opened on a clock, then on a byte count, instead of a measurement. Rank
     *  first, and keep schema order inside a tier — Array#sort is stable, so
     *  the panel and this agree.
     */
    function pickValueColumn(schema, partCols) {
      const cands = signalColumns(schema, partCols);
      if (!cands.length) return null;
      const exact = cands.find(function (n) { return /^value$/i.test(n); });
      if (exact) return exact;
      const ranked = cands.slice().sort(function (a, b) { return yRank(a) - yRank(b); });
      const best = yRank(ranked[0]);
      const tier = ranked.filter(function (n) { return yRank(n) === best; });
      const valueish = tier.find(function (n) { return /val|reading|measure/i.test(n); });
      return valueish || tier[0];
    }

    return {
      /** The table's partition columns, in tree order: how deep a path can go. */
      partitionColumns: function () {
        return T() ? loadPartCols() : Promise.resolve([]);
      },

      /** Tree level under ``path``: one node per partition value, the deepest
       *  level's values being the selectable channels.
       *
       *  Value columns are NOT nodes here — a channel is a whole partition and
       *  its columns are ticked in the columns panel. A table with no partition
       *  columns therefore has no level to browse, so it gets ONE synthetic leaf
       *  standing for the whole table: without it the sidebar offered nothing to
       *  tick and the value-column picker had no channel to fan out over, which
       *  made an unpartitioned table unplottable. That leaf carries no count —
       *  /partitions has no level to count here — and displays the table name.
       *
       *  It stands for a SUCCESSFUL empty listing only. When the listing fails
       *  this rejects with the lake's reason, which the sidebar renders in
       *  place of the tree: a partitioned table whose catalog call was refused
       *  must not look like a table with nothing to browse. */
      children: function (path) {
        // The view renders its tree on mount, before a table has been picked.
        // Asking the catalog about table "" is a guaranteed-useless round trip
        // and puts an error in the sidebar where "pick a table" belongs.
        if (!T()) return Promise.resolve([]);

        // Levels are cached for the page, including across reopening the view.
        const ck = "lvl|" + T() + "|" + (path || "");
        if (levelCache[ck]) return Promise.resolve(levelCache[ck]);
        if (levelInflight[ck]) return levelInflight[ck];

        const load = loadPartCols()
          .then(function (partCols) {
            const depth = String(path || "").split("/").filter(Boolean).length;

            // No partition columns, reported as such: the table is the only channel.
            if (!partCols.length) {
              return depth ? [] : [{
                value: T(),
                seg: WHOLE_TABLE,
                leaf: true,
                kind: "physical",
                meta: { name: T(), unit: "", dec: 3 },
              }];
            }

            // Past the last partition level there is nothing left to browse.
            if (depth >= partCols.length) return [];

            // /partitions is the primary route for EVERY level, physical and
            // virtual alike — the same single call per level the lakehouse's own
            // UI makes, measured in its HAR at 46-90ms for all six levels of
            // can_signals_v13 including the virtual ones.
            //
            // It used to try /partition-values first, on the theory that a
            // manifest SELECT DISTINCT beats walking the tree. That was wrong in
            // the worst way: /partition-values cannot serve a VIRTUAL column, so
            // a virtual level paid a slow refusal, then another for
            // /partition-combinations, before reaching the route that answers in
            // milliseconds. The "virtual levels are inherently slow" conclusion
            // was an artefact of that, not a property of the lake.
            const leafLevel = depth >= partCols.length - 1;
            const col = partCols[depth];
            const t0 = Date.now();
            const fallback = function (why) {
              return distinctChildren(path, col, leafLevel)
                .then(function (nodes) {
                  noteLevel(path, "manifest", Date.now() - t0, nodes.length, why);
                  return nodes;
                })
                .catch(function (e) {
                  noteLevel(path, "none", Date.now() - t0, 0, e);
                  return [];
                });
            };
            return listChildren(path, col)
              .then(function (nodes) {
                if (nodes.length) {
                  noteLevel(path, "partitions", Date.now() - t0, nodes.length);
                  return nodes;
                }
                // Empty is ambiguous (truly empty, or an older catalog that
                // cannot list this level) so try the manifest before giving up.
                return fallback(new Error("/partitions returned no nodes"));
              })
              .catch(fallback);
          });

        levelInflight[ck] = load
          .then(function (nodes) {
            // Only a non-empty level is cached: an empty one is usually a
            // transient failure downstream, and caching it would make the
            // branch look permanently childless.
            if (nodes && nodes.length) levelCache[ck] = nodes;
            delete levelInflight[ck];
            return nodes || [];
          })
          .catch(function (e) { delete levelInflight[ck]; throw e; });
        return levelInflight[ck];
      },

      // Cached for the life of the view: /api/lake/tables asks the catalog for
      // metadata across every table, which is the slowest call here, and the
      // list does not change while someone is measuring.
      /** Tables the user can measure on.
       *
       *  Names only: asking for metadata makes the catalog fetch each table
       *  individually to compute counts and sizes, and the picker needs a list
       *  to click, not sizes.
       *
       *  Cached in sessionStorage as well as in memory, because this call is
       *  slow for a reason QuixLab cannot fix: with per-user scoping enabled
       *  the catalog resolves EVERY table's location to check read access, so
       *  the cost is per-table however little we ask for. The list barely
       *  changes, so the second open should not pay it again.
       */
      tables: function () {
        if (tablesPromise) return tablesPromise;

        const hit = cachedTables();
        if (hit) {
          // Show it NOW. A stale list is refreshed behind the user so a new
          // table still turns up, but nobody waits on the catalog for it.
          tablesPromise = Promise.resolve(hit.tables);
          if (hit.stale) {
            fetchTables().then(function (list) {
              if (list && list.length) tablesPromise = Promise.resolve(list);
            }).catch(function () { /* the cached list is still good */ });
          }
          return tablesPromise;
        }

        tablesPromise = fetchTables().catch(function (e) {
          tablesPromise = null;        // let a failure be retried
          throw e;
        });
        return tablesPromise;
      },

      /** Columns for the X / Y pickers.
       *
       *  renderColumns filters on ``type`` being exactly "numeric" or
       *  "timestamp", so the catalog's SQL types are normalised here. Returning
       *  bare names (as this first did) left both selects empty, which is why
       *  a long/narrow table had no way to say "plot the value column".
       */
      columns: function () {
        return loadSchema().then(function (s) {
          return s.columns.map(function (c) {
            const t = String(c.type || "");
            return {
              name: c.name,
              type: TIMEISH.test(t) ? "timestamp"
                : NUMERIC.test(t) ? "numeric" : "other",
            };
          });
        });
      },

      /** The column this table most likely keeps its readings in. Used to seed
       *  the value-column selection, so a first plot needs no trip to the
       *  columns panel. */
      defaultY: function () {
        return loadSchema().then(function (schema) {
          return loadPartCols().then(function (partCols) {
            return pickValueColumn(schema, partCols);
          });
        });
      },

      /** The time column detection settled on, so the X select can show the
       *  column actually being used rather than a guess of its own. */
      defaultX: function () {
        return loadSchema().then(function (schema) { return schema.timeCol || null; });
      },

      /** Full time extent of the active table. Synchronous by contract, so it
       *  serves the cached value; loadBounds fills it before first paint. */
      bounds: function () {
        return box().bounds || null;
      },

      /** Whole-table time bounds, from METADATA ONLY.
       *
       *  The catalog does not expose min/max on the time column today, so this
       *  resolves to null and the view runs unbounded. That is deliberate:
       *  min/max over the whole table is a full column scan, and doing it at
       *  mount blocked the tree behind a query nobody asked for. Skipping it
       *  is the correct trade — bounds are a convenience for "fit all" and the
       *  range strip, not a prerequisite for plotting.
       *
       *  ``extent(ids)`` still answers the useful question, and cheaply: it is
       *  filtered to the SELECTED partitions, so the engine prunes to a few
       *  files instead of the table. That is what the fit button uses.
       */
      loadBounds: function () {
        return Promise.resolve(box().bounds || null);
      },

      /** Where the selected signals actually hold data. */
      extent: function (ids, opts) {
        const list = (ids || []).map(parseId);
        if (!list.length) return Promise.resolve(null);

        // Extent is the most expensive query this provider makes: it has no time
        // bound by definition, so on a table where the partition filters are a
        // row filter rather than a directory prune it reads a lot. It is also
        // the one most likely to be asked for repeatedly — every press of fit,
        // on an unchanged selection. Cache the answer and share in-flight
        // requests, keyed by exactly what the query depends on.
        const key = T() + "|" + (xOf(opts) || "") + "|" +
          (ids || []).slice().sort().join(",");
        const hit = extentCache[key];
        if (hit && (Date.now() - hit.at) < EXTENT_TTL_MS) {
          return Promise.resolve(hit.value);
        }
        if (extentInflight[key]) return extentInflight[key];

        const run = loadSchema().then(function (schema) {
          // Same X resolution as frames(): on a table whose clock was chosen by
          // hand, detection alone finds nothing and fit would silently no-op.
          const ts = tsMs(schema, xOf(opts));
          if (!ts) return null;              // nothing to take an extent over
          // One query per distinct partition scope, unioned client-side.
          const scopes = {};
          list.forEach(function (p) { scopes[p.prefix] = p.where; });
          const keys = Object.keys(scopes);
          // ORDER BY ... LIMIT 1, not min()/max(). Compaction writes each file
          // sorted by the time column and records its bounds precisely so that
          // "an ORDER BY can skip files and a bare LIMIT can plan exactly"
          // (duck_db_service._compacted_file_entry) — the streaming fast path.
          // min()/max() gets none of that and reads the column across every
          // file. Measured in the lakehouse UI's own HAR: the ORDER BY shape
          // answers in 1.4s where our min/max was hitting 45-120s and timing
          // out. Two queries are still far cheaper than one aggregate.
          const endpoint = function (k, dir) {
            return sql(
              "SELECT " + ts + " AS t FROM " + ident(T()) +
              whereSql(ts, scopes[k]) + " ORDER BY " + ts + " " + dir + " LIMIT 1",
              { tag: "extent", maxRows: 0 }
            );
          };
          return Promise.all(keys.map(function (k) {
            return Promise.all([endpoint(k, "ASC"), endpoint(k, "DESC")])
              .then(function (pair) {
                const lo = pair[0][0], hi = pair[1][0];
                return { rows: [{ lo: lo && firstValue(lo), hi: hi && firstValue(hi) }] };
              })
              .catch(function (e) { return { rows: [], err: e }; });
          })).then(function (res) {
            // A failed query is NOT "no data". Swallowing the error here turned a
            // timeout into a null extent, and the caller could then only say
            // something vague and self-contradictory — "found no data, the lake
            // did not answer". Failing loudly lets it report the real reason.
            const errs = res.filter(function (r) { return r.err; });
            if (res.length && errs.length === res.length) throw errs[0].err;

            let lo = Infinity, hi = -Infinity;
            res.forEach(function (out) {
              const r = out.rows[0];
              if (!r) return;
              const pick = function (name) {
                if (r[name] != null) return r[name];
                const k = Object.keys(r).find(function (x) {
                  return x.toLowerCase() === name;
                });
                return k === undefined ? null : r[k];
              };
              const rlo = pick("lo"), rhi = pick("hi");
              if (rlo == null || rhi == null) return;
              if (rlo < lo) lo = rlo;
              if (rhi > hi) hi = rhi;
            });
            if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) return null;
            return { t0: Math.floor(lo), t1: Math.ceil(hi) };
          });
        });

        extentInflight[key] = run
          .then(function (value) {
            extentCache[key] = { at: Date.now(), value: value };
            delete extentInflight[key];
            return value;
          })
          .catch(function (e) {
            // Failures are NOT cached: the usual cause is the lake being
            // briefly unavailable, and the next press should try again.
            delete extentInflight[key];
            throw e;
          });
        return extentInflight[key];
      },

      /** Each signal's engineering unit, read from a column in the data.
       *
       *  The catalog carries no per-column units (its /schema returns
       *  name/type/nullable only), so on a long/narrow table the unit sits in a
       *  column beside the value. One row per signal scope is enough — the unit
       *  does not vary within a signal — so this is a LIMIT 1 per scope, not a
       *  scan, and the view caches the answer per signal.
       */
      units: function (ids, opts) {
        const col = opts && opts.unit;
        if (!col || !(ids || []).length) return Promise.resolve({});
        return loadSchema().then(function (schema) {
          const known = schema.columns.some(function (c) { return c.name === col; });
          if (!known) return {};
          const list = (ids || []).map(function (id) {
            const p = parseId(id);
            p.id = id;
            return p;
          });
          return Promise.all(list.map(function (p) {
            // Built here rather than via whereSql: that helper owns the WHERE
            // keyword, and this query needs one more predicate alongside the
            // partition filters.
            const preds = (p.where || []).map(function (w) {
              return partitionPredicate(w.col, w.val);
            }).concat([ident(col) + " IS NOT NULL"]);
            const query = "SELECT " + ident(col) + " AS u FROM " + ident(T()) +
              " WHERE " + preds.join(" AND ") + " LIMIT 1";
            return sql(query, { tag: "units" })
              .then(function (rows) {
                return { id: p.id, unit: rows[0] && rows[0].u != null ? String(rows[0].u) : "" };
              })
              .catch(function () { return { id: p.id, unit: "" }; });
          })).then(function (res) {
            // A signal with no unit is a normal answer, never an error.
            const out = {};
            res.forEach(function (r) { out[r.id] = r.unit; });
            return out;
          });
        });
      },

      meta: function (id) {
        // The whole-table channel has no partition value to be named after.
        if (String(id) === WHOLE_TABLE) return { name: T(), unit: "", dec: 3 };
        // The deepest partition value, or the column a legacy id names.
        return { name: parseId(id).label, unit: "", dec: 3 };
      },

      /** Bucketed min/max/mean/count per trace over [q.t0, q.t1).
       *
       *  Traces sharing a partition scope are aggregated in ONE query — one set
       *  of column expressions over the same bucket grouping — so a 6-trace
       *  window costs one round trip instead of six.
       *
       *  Which column a trace aggregates, in order: its own trailing bare
       *  segment when it has one (the view's fan-out keys and older layouts both
       *  carry one), then ``q.cols[id].y`` from the columns panel, then the
       *  table's likeliest value column.
       */
      frames: function (ids, q) {
        const list = (ids || []).map(function (id) {
          const p = parseId(id);
          p.id = id;
          return p;
        });
        if (!list.length) return Promise.resolve({});

        const B = Math.max(1, Math.min(maxBuckets(), Math.floor(q.buckets) || 1));
        const t0 = Math.floor(q.t0), t1 = Math.ceil(q.t1);
        const span = Math.max(1, t1 - t0);

        return Promise.all([loadSchema(), loadPartCols()]).then(function (r0) {
          const schema = r0[0], partCols = r0[1];
          const fallback = pickValueColumn(schema, partCols);
          const colFor = function (p) {
            const picked = (q.cols && q.cols[p.id]) || {};
            return p.column || picked.y || fallback;
          };

          const ts = tsMs(schema, xOf(q));
          if (!ts) {
            if (window.console) console.warn("[measure] " + NO_TIME);
            return {};
          }

          const groups = {};
          list.forEach(function (p) {
            p.col = colFor(p);
            if (!p.col) return;          // nothing to aggregate for this signal
            (groups[p.prefix] = groups[p.prefix] || { where: p.where, sigs: [] })
              .sigs.push(p);
          });

          return Promise.all(Object.keys(groups).map(function (k) {
            const g = groups[k];
            const sel = ["CAST(floor((" + ts + " - " + t0 + ") * " + B +
              " / " + span + ") AS INTEGER) AS qb"];
            g.sigs.forEach(function (p, i) {
              const c = ident(p.col);
              sel.push("min(" + c + ") AS lo" + i, "max(" + c + ") AS hi" + i,
                "sum(" + c + ") AS su" + i, "count(" + c + ") AS ct" + i);
            });
            // No LIMIT: GROUP BY qb already bounds this to at most B rows.
            const query = "SELECT " + sel.join(", ") + " FROM " + ident(T()) +
              whereSql(ts, g.where, t0, t1) +
              " GROUP BY qb ORDER BY qb";
            return sql(query, { tag: "frames", gen: q.gen || 0, maxRows: 0 })
              .then(function (rows) { return { g: g, rows: rows }; })
              .catch(function (e) {
                if (window.console) console.warn("[measure] frame query failed", e, query);
                // Keep the reason. A swallowed error reads as "no data", which
                // is indistinguishable from an empty range and sends everyone
                // hunting the wrong thing.
                return { g: g, rows: [], err: e };
              });
          })).then(function (res) {
            // If EVERY group failed there is no data to show and a reason to
            // report. Returning empty frames here rendered as "no data", which
            // is indistinguishable from an empty range — the exact confusion
            // this was supposed to remove. One group failing is different: the
            // others still have frames, and those windows should draw.
            const errs = res.filter(function (r) { return r.err; });
            if (res.length && errs.length === res.length) throw errs[0].err;
            const out = {};
            res.forEach(function (r) {
              // Dense frames: SQL returns only non-empty buckets, but the view
              // indexes buckets positionally, so gaps must stay real gaps.
              r.g.sigs.forEach(function (p) {
                const f = { min: [], max: [], mean: [], count: [] };
                for (let b = 0; b < B; b++) {
                  f.min.push(NaN); f.max.push(NaN); f.mean.push(NaN); f.count.push(0);
                }
                out[p.id] = f;
              });
              r.rows.forEach(function (row) {
                // Read result columns case-INSENSITIVELY. The alias case is not
                // guaranteed to survive the engine and the CSV/JSON round trip,
                // and an exact-name miss skips every bucket silently — an empty
                // plot with no error, which is the worst possible failure.
                const get = function (name) {
                  if (row[name] !== undefined) return row[name];
                  const lower = name.toLowerCase();
                  const key = Object.keys(row).find(function (k) {
                    return k.toLowerCase() === lower;
                  });
                  return key === undefined ? undefined : row[key];
                };
                let b = Number(get("qb"));
                if (!isFinite(b) || b < 0) return;
                // A sample at the range end floors to B — fold it into the last bucket.
                if (b >= B) b = B - 1;
                r.g.sigs.forEach(function (p, i) {
                  const n = Number(get("ct" + i)) || 0;
                  if (!n) return;
                  const f = out[p.id];
                  f.min[b] = Number(get("lo" + i));
                  f.max[b] = Number(get("hi" + i));
                  f.mean[b] = Number(get("su" + i)) / n;
                  f.count[b] = n;
                });
              });
            });
            return out;
          });
        });
      },
    };
  }

  /** Which provider to use.
   *
   *  Lake by default — the dataset node must work for an ordinary user with
   *  no console involved. ``?qmProvider=demo`` (or window.QM_PROVIDER) forces
   *  the synthetic one, so the frontend stays workable with no lake wired up.
   */
  function pick() {
    let want = "";
    try {
      want = new URLSearchParams(window.location.search).get("qmProvider") || "";
    } catch (e) { /* no URL access — fall through to the global */ }
    want = String(window.QM_PROVIDER || want || "lake").toLowerCase();
    return (want === "demo" || want === "synthetic") ? "demo" : "lake";
  }

  // Nothing is fetched at load. See warmTables: enumerating tables costs the
  // lake a per-table catalog lookup for every table it has, so it happens only
  // when someone asks for the list.

  window.MeasureLake = {
    provider: makeProvider,
    pick: pick,
    sql: sql,
    warmTables: warmTables,
    cachedTables: cachedTables,
    /** The last 50 queries, newest last: {sql, ms, rows, columns, error}. */
    queries: function () { return QUERY_LOG.slice(); },
    lastQuery: function () { return QUERY_LOG[QUERY_LOG.length - 1] || null; },
    /** Only the ones that failed — usually what you actually want. */
    failedQueries: function () {
      return QUERY_LOG.filter(function (q) { return q.error; });
    },
    /** The last 50 metadata calls: {url, ms, error}. The sidebar is made of
     *  these, and none of them are queued behind a scan. */
    meta: function () { return META_LOG.slice(); },
    slowMeta: function (ms) {
      const lim = ms == null ? 500 : ms;
      return META_LOG.filter(function (m) { return (m.ms || 0) >= lim; });
    },
    /** Per tree level: {path, route, ms, nodes, error}. route "partitions" is the
     *  fast primary; anything else means the fallback chain ran. */
    levels: function () { return LEVEL_LOG.slice(); },
    /** How many queries are running vs waiting for a slot. */
    load: function () {
      const lanes = {};
      active.forEach(function (j) { lanes[j.tag || "-"] = (lanes[j.tag || "-"] || 0) + 1; });
      return {
        inflight: active.size, queued: waiting.length, max: MAX_INFLIGHT,
        lanes: lanes, laneCap: LANE_CAP,
      };
    },
    maxBuckets: maxBuckets,
    // exported for unit tests
    _parseId: parseId,
    _epochScale: epochScale,
  };
})();
