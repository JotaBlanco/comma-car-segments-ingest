# Frontend Checklist

Living checklist for the Test Manager frontend (`feature/tm-greenfield`). Tick things as they land; add new items as they come up.

## Build

- [x] Greenfield app scaffold — Next.js 16 / React 19 / Tailwind v4 / shadcn / TanStack Query, TypeScript strict
- [x] Design system ported 1:1 from the approved prototype (tokens, fonts, badges, density)
- [x] `/design-system` living reference page
- [x] All core screens: Home, Runs, Run detail (signals / files / results / journal), Lineage, Work orders + detail, Files + detail, Signals catalog + detail
- [x] Global search (⌘K) with grouped results + prototype-style default view (all four entity groups before typing)
- [x] Demo beats working end-to-end: planning-sync amber→green with backfill, invalid flag with mandatory reason, inline unit edit journalled as manual
- [x] Dark mode — crafted palette (not an inversion), topbar toggle, no-FOUC, `?theme=` + postMessage hooks for parent-app embedding
- [x] Account menu — portal API profile (`GET /profile` + org), plugin token handshake + PAT dialog fallback, signed-out state
- [x] Definitions screen — `/definitions` lists the test definitions and filters the orphaned ones (TR-001). Done 20 Aug 2026 — `app/definitions/page.tsx`, `components/screens/definitions/`, `tests/components/definitions-screen.test.tsx`
- [x] Journal verified mark — both timelines show "Verified by the Quix platform" for a platform actor (FR-DM-055, NFR-DM-049). Done 20 Aug 2026 — `components/shared/verified-actor-mark.tsx:3`, `tests/components/journal-actor-verified.test.tsx`
- [x] Registry assistant panel — Ask trigger, streaming chat, frame renderers, resize, dock left and undock. Done 20 Aug 2026 — `components/assistant/assistant-panel.tsx`, `tests/components/assistant-panel.test.tsx`
- [x] `MultiSelectFilter` takes an `emptyText`, so a filter that derives no options says why. Done 20 Aug 2026 — `components/shared/multi-select-filter.tsx:35`, `components/screens/signals/signals-screen.tsx:221`
- [x] Table filtering, sorting & pagination on all four list screens — quick views with live counts, multi-select filter popovers, active-filter pills, debounced search, sortable headers, footer pager; all state URL-driven; fake signals footer removed

## Backend integration

- [x] Fully working built-in mock API implementing the agreed contract (21 endpoints, stateful, seeded demo cast)
- [x] One-variable backend switch — `TM_BE_URL` proxies all `/api/v1` traffic to the real API; unset falls back to the mock
- [x] Verified against the real dockerized stack (FastAPI + Mongo + mock planning + seed) with live write/read-back proof
- [x] Null-tolerant rendering of mirror fields (real BE filler work orders exposed unguarded nulls)
- [x] `/health` + `/ready` unprefixed per contract
- [x] BE table-filters support implemented (multi-value filters, sort whitelists, optional `view_counts`, 8 new indexes) — contract §E entries recorded, pending team ratification

## Testing

- [x] Contract golden tests — FE half of the team's PR contract guard. **28 golden requests now, 4 expected-fail (20 Aug 2026)** — `tests/contract.golden.test.ts:162` `KNOWN_DRIFT`, `../api/tests/golden_requests.json`
- [x] Mock-db unit suite — 96 tests; doubles as the BE acceptance spec (2 `test.fails` tracking contract v1.1)
- [x] Component tests — 43 tests over shared design-system components. **257 component tests now, over 45 files (20 Aug 2026).**
- [x] Playwright E2E — 15 specs incl. the full demo script run twice back-to-back, invalid flag, inline edit, search, deep links
- [x] WCAG 2.1 AA — 26 axe scans (13 screens/states × light + dark), zero suppressions; contrast tokens fixed to ≥4.5:1
- [x] Demo P0 bug fixes — save-on-blur unit edit, specific 409 toast, live manual-correction annotation
- [x] Table-filters test coverage — 77 BE endpoint tests, 44 component + 39 unit additions, 3 new E2E specs, 3 cross-side golden requests
- [x] E2E isolated build dir (`.next-e2e`) — suite runs alongside a live dev server, dist-lock conflict gone
- [x] The Playwright rig starts its own server and never reuses a stale one. Done 20 Aug 2026 — `playwright.config.ts:27`
- [x] Suite counts, measured 20 Aug 2026: 257 component tests, 317 unit tests, 10 Playwright spec files. `npm run build` and `npm run typecheck` are clean.

## Open decisions

- [x] Demo mode: built-in mock (self-contained) vs live BE stack. **Settled: the live BE stack.** The deployment sets `TM_BE_URL: http://tm-api`, so the mock never answers there. There is no `DEMO_MODE` flag any more — every mode flag went on 20 Aug 2026. Done 20 Aug 2026 — `../quix.yaml` (Test Manager Frontend, `TM_BE_URL`). The `DEMO_MODE` note stood in `../api/api/routers/admin.py`; that file is deleted since 21 Aug 2026.
- [x] "Open in QuixLab" buttons: shown only when a real QuixLab answers, and hidden otherwise (R-04). The destination is real since 21 Aug 2026. The API reads `TM_QUIXLAB_URL` and serves `GET /api/v1/integrations/quixlab-url`; `app/layout.tsx` asks that route and a click opens the site root plus `?open=analysis&kind=notebook`. Set the variable on the API deployment only. See `plans/API-CONTRACT.md` §D-Integrations.
- [x] File download (`GET /files/{id}/download`): **shipped.** Done 20 Aug 2026 — `../api/api/routers/files.py:653`, `e2e/file-download.spec.ts`

## Up next

- [ ] Adopt contract v1.1 once agreed (`api:catalogue` spelling, unknown-field 422, live `runs_today` — two unit `test.fails` are waiting on this; table-filters §E3–E6 entries pending ratification)
- [ ] Add a null-field work order to the mock seed so tests cover the real-BE shape (needs coordinated E2E count updates)
- [ ] Flag to BE team: api docker image fails to build on Apple Silicon (`zstd` via asammdf, ingest group)
- [x] Quix deployment wiring — `quix.yaml` sets `API_URL`, `TM_BE_URL` and the secret `TM_API_TOKEN` on the front-end deployment. `NEXT_PUBLIC_TM_API_TOKEN` is gone on purpose: the token stays on the server. Done 20 Aug 2026 — `../quix.yaml` (Test Manager Frontend)
- [ ] Full demo rehearsal on the presentation machine (both modes)
- [ ] Post-demo: retire the mock layer (`app/api/v1` + `lib/mock`) once the BE is authoritative and CI runs against the docker stack
