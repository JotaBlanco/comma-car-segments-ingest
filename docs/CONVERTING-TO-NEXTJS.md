# Converting a dashboard to a Next.js app with live data

`tm-dashboard-signal-analytics` is the worked example. It was a static nginx page
and is now a Next.js app that can read the real registry. Read its files
alongside this note — this explains the decisions, not the code.

Five dashboards remain: `rig-ops`, `plan-to-proof`, `cell-ops`,
`programme-delivery`, `data-integrity`.

---

## 1. Why Next.js, and not a static page with an nginx proxy

We tried the static route first. It failed, and the reason is worth knowing
because it is invisible until you deploy.

The API sends **no CORS headers at all**. There is no `CORSMiddleware` anywhere
in `api/api/main.py`, not even on `/health`. `Authorization` is not a
CORS-safelisted header, so any authenticated cross-origin call triggers an
`OPTIONS` preflight, gets **405**, and the real request is never sent. A plugin
page cannot call the API directly from the browser whatever token it holds.

So the page must fetch **same-origin** and something must proxy. With nginx that
meant a variable `proxy_pass` plus an explicit `resolver`, and **nginx's own
resolver does not apply the Kubernetes search domains from `/etc/resolv.conf`**.
The short service name never resolved and every call answered **502**.

Node does not have that problem: it uses the system resolver, so the bare
service name resolves. That is the whole reason for the rewrite. It is not about
React.

**Do not add CORS to the API to avoid this.** The origin allow-list would become
the entire access boundary and needs a security review. The proxy is cheaper and
already proven.

---

## 2. Split the work across two agents, with disjoint ownership

One app, two agents in parallel. They must never touch the same file.

**Agent A — infrastructure**

```
package.json  next.config.ts  tsconfig.json  postcss.config.mjs  .gitignore
app/layout.tsx  app/globals.css
app/api/proxy/[...path]/route.ts
lib/portal/{token-store,client,use-portal-auth}.ts
lib/api/client.ts
dockerfile  app.yaml  README.md
+ this app's deployment block in quix.yaml
```

**Agent B — UI and data**

```
app/page.tsx
components/**
lib/data/**
```

**The contract between them.** Fix this in both briefs so neither has to guess:

```ts
// from @/lib/api/client
export class ApiError extends Error { status: number; code: string; detail: string }
export async function apiGet<T>(path: string,
  params?: Record<string, string | number | string[] | undefined>): Promise<T>

// from @/lib/portal/use-portal-auth
export type AuthPhase = "resolving" | "authenticated" | "signed-out"
export function usePortalAuth(): { phase: AuthPhase; setPatToken(t: string): void }
```

Agent B writes against the contract and does not wait for A. Unresolved imports
mid-flight are expected.

**A owns `package.json`.** B must report the dependencies it needs
(`chart.js`, `react-chartjs-2`) rather than editing the file. Reconcile this
yourself if A finishes first — that gap cost a build on the worked example.

Use the **fable** model and tell both agents to invoke the `frontend-design`
skill first.

---

## 3. Copy the frontend, do not invent

Reference: `/Users/chrisgilchrist/Code/work/Quix.TestManager/frontend`.

- `app/api/proxy/[...path]/route.ts` — read `x-portal-token` from the browser
  request and **promote it to `Authorization: Bearer`** on the onward call. Keep
  the `isOwnPage` same-origin guard, strip hop-by-hop headers, stream bodies,
  `redirect: "manual"`. Answer a JSON 502 when the backend is unreachable so the
  page can render an honest failure instead of blanking.
- `lib/portal/token-store.ts` — the handshake. Key `tm.portal.token`;
  `{type:"REQUEST_AUTH_TOKEN"}` posted to `window.parent` **targeted at the
  trusted origin, never `"*"`**; replies validated by `event.origin` **first**;
  trusted origins from `?portalOrigin=` (require `url.origin === value`, hostname
  ending `.quix.io`) and **memoised**, because that parameter is lost on the
  first client-side navigation; `#token=` fragment read once, only that key
  removed, `history.replaceState`; subscribe to unprompted `AUTH_TOKEN` pushes,
  which is the only refresh path; a pasted-PAT fallback for standalone use.
- `app/globals.css` — copy the token blocks **verbatim**, both `:root` and
  `.dark`. The dark theme is the Portal grey palette; it moved on 26 Aug 2026 and
  will move again. Copy, never re-derive.
- Fonts: Schibsted Grotesk + IBM Plex Mono via `next/font/google` as
  `--font-sans` / `--font-mono`.
- Theme: `dark` class on `<html>`, persisted under **`tm-theme`** — the key the
  whole Portal shares — with the no-FOUC inline script, `?theme=` override and
  the `postMessage {type:"tm-theme"}` host hook.

**The token never reaches a URL, a query string or a log.** Browser → proxy on
`x-portal-token`; proxy → API on `Authorization`.

---

## 4. Deployment

Mirror the **Test Manager - Frontend** block:

```yaml
network:
  serviceName: <existing-name>          # keep it
  ports: [{ port: 80, targetPort: 3000 }]
variables:
  - name: API_URL
    value: http://test-manager-backend   # bare short name, NO :80
```

Keep `publicAccess.urlPrefix`, `plugin.embeddedView` and `globalItem` exactly as
they are — these are global plugins and that block is what puts them in the menu.

`API_URL` is read **server-side at request time**, never baked at build and never
sent to the browser. The bare name is what the frontend, tm-connector, Test Bench
and the planning mock all use successfully.

Dockerfile: two-stage node build → `next build` → `next start` on 3000. Copy
`frontend/dockerfile`.

---

## 5. The endpoints, and what they cost

| Call | Purpose |
|---|---|
| `test-runs/{id}` | metadata. **Duration is not a field** — derive from `started_at`/`ended_at`, both nullable |
| `test-runs/{id}/lineage` | work-order and definition **titles** (the run detail gives ids only) |
| `test-runs/{id}/signals` `page_size:500` | the whole per-signal table in one page. Registry-only, **cannot 503** |
| `signals/{name}/stats` `window:"run"` | **an entire cross-run chart in ONE request** — a row per run with `run_id, run_date, status, min, max, mean, std`, newest first |
| `test-runs` `sort:"first_data_at"` | run discovery. That is the **only** sortable key, and there is no `before=` filter — slice client-side |

`page_size` is an allow-list: **10, 20, 50, 100, 200, 500**. Anything else is 422.

**Budget: five requests a page.** Only `signals/{name}/stats` touches QuixLake, so
it is the only call that can fail on infrastructure (**503 `lake_unavailable``**).
Render metadata and the table first and let history panels fail on their own.

---

## 6. Rules that are not negotiable

1. **A null renders as an em dash.** Never a zero, never `"null"`. Real nulls
   occur: percentiles are null by design when a run spans two or more measured
   files, and `stats` itself can be null.
2. **Status is the real enum** — `complete | awaiting_work_order | invalid`.
   `"Linked"` is a display label only. **Invalidity is a field on the row, never
   an array index** — chart colour closures must read `status`.
3. **Captions and `aria-label`s are built from the data.** A sentence written for
   the fixture becomes a lie under live data, and the aria-label is the only
   description a screen-reader user gets.
4. **Panels degrade independently.** Never blank the page for one failed call,
   and never show a fixture number under the Live tag — fields go to em dashes.
5. **Demo stays the default and complete.** It is what runs on stage. Keep the
   fixture as typed data in `lib/data/`, not markup, so one renderer serves both
   modes and they cannot drift.
6. States to design, each with real copy: resolving auth, signed-out (offer the
   PAT paste), per-panel loading skeletons, 401, 404, 503, network failure, empty
   run, short history.

---

## 7. Traps that have already cost us

**The `data/` gitignore trap.** The repository root ignores `data/` for seed
output. That pattern matches **at any depth**, so it silently swallowed
`lib/data/` — the entire data layer — and the image build failed with
`module-not-found` while local builds kept passing. `signal-analytics` re-includes
its own directory in its `.gitignore`; **every converted app needs the same
exception.**

**Verify the commit, not your disk.** `tsc` and `next build` passing locally
prove nothing about what is in the commit. After staging, run:

```sh
cd <app> && echo "disk $(find components lib app -type f | wc -l) / git $(git ls-files components lib app | wc -l)"
```

They must match.

**Do not use a literal hostname in any nginx config.** If one survives anywhere,
nginx refuses to start when the API is unresolvable, which takes demo mode down
too.

---

## 8. What the live data actually looks like

Measured 26 Aug 2026. Know this before designing a live view:

- **2 runs total** — `TAS-90001`, `TAS-90002`, both `complete`, both under
  `TD-RLD-301`.
- **261 signals**, every one a CAN channel, **every unit null**, max `run_count`
  of 2.
- No battery-temperature or coolant signals; the fixtures assume an EX90 thermal
  campaign that does not exist in this workspace.

So a cross-run trend can show at most two points, and any caption that appends a
unit must handle null. Design live mode to be honest about a thin dataset rather
than to look like the fixture. More runs is pipeline work, not dashboard work.

Two known bugs in the worked example, still open, worth not repeating:
pluralisation (`1 RUNS`) and a caption that reads `Sigma in .` when the unit is
null.

---

## 9. Order of work

1. Convert **one** dashboard at a time. Two agents, disjoint files, one contract.
2. Build, typecheck, and **check disk against `git ls-files`**.
3. Serve it with `next start` and verify in a browser: both themes, no console
   errors, no overflow at 390px, demo mode unchanged.
4. Commit, push, then sync and redeploy in the Portal — the deployment is the
   only real proof of DNS and the Portal handshake.
5. Only then start the next one.
