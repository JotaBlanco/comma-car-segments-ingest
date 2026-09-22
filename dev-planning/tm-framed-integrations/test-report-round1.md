# Test report — tm-framed-integrations — Round 1

**Architecture doc:** `dev-planning/tm-framed-integrations/architecture.md`
**No `spec.md` exists for this feature** — the architecture doc is the only
written requirements source, so every check below cites it instead of a spec
section.
**Scope:** the 11 files ArchDev's checklist named (frame extraction, `/quixlab`,
`/lakehouse`, sidebar Links, `lib/quixlab.ts`, three docstring-only files) plus
the five test files ArchDev flagged as encoding the old tab behaviour.

## Sanity print

| Check | Result | Count |
|---|---|---|
| Typecheck (this change) | PASS | 0 errors after fixing 2 test files |
| Lint (this change's 11 files + 6 test files touched) | PASS | 0 errors, 0 warnings |
| Lint (whole repo) | 33 errors / 53 warnings, all outside this change | see §2 |
| Tests updated | 6 files | quixlab-embed, signals-selection, quixlab-open, lakehouse-link, new-tab-marks, lakehouse-late-token |
| Test added | 1 file | quixlab-screen.test.tsx (2 cases) |
| Component suite (`test:components`) | PASS | 115 files / 927 tests |
| Unit suite (`test:unit`) | 2 pre-existing failures, unrelated | 90 pass / 2 fail / 92 files, 941 pass / 2 fail / 2 expected-fail / 945 tests |
| Browser check | Ran against a pre-existing dev server; both pages render but need a live token to go further | see §5 |

## 1. Typecheck

`npm run typecheck` (`next typegen && tsc --noEmit`) failed exactly where the
brief predicted, and nowhere else:

```
tests/components/quixlab-embed.test.tsx(21,10): error TS2459: Module '"@/components/screens/run-detail/quixlab-panel"' declares 'QuixLabFrame' locally, but it is not exported.
tests/components/signals-selection.test.tsx(70,10): error TS2459: Module '"@/components/screens/run-detail/quixlab-panel"' declares 'QuixLabFrame' locally, but it is not exported.
```

Fixed both: import `QuixLabFrame` from `@/components/shared/quixlab-frame`
and pass `embedUrl`/`origin` instead of `instance=`. Re-run: clean.

## 2. Lint

No `.pre-commit-config.yaml` in this repo — used the repo's own pinned gate,
`npm run lint` (`eslint`, `eslint-config-next@16.3.1` from `package.json`).

Whole-repo run: 33 errors, 53 warnings. Every one is in a file **outside**
this change's 11-file inventory and outside the 6 test files this round
touched:

- `components/screens/run-detail/explore-tab/explore-tab.tsx` (2 errors)
- `components/screens/run-detail/run-detail-screen.tsx` (1 error)
- `components/screens/runs/run-groups.tsx` (2 warnings)
- `components/shared/export-button.tsx` (2 warnings)
- `lib/hooks/use-announce.ts` (1 error)
- `lib/mock/db.ts` (7 warnings)
- `lib/portal/use-portal-auth.ts` (1 error)
- `public/explore/*.js` (26 errors, 41 warnings — pre-existing vendored/legacy JS)

None of these files appear in `git status` as dirty, and none are in the
architecture doc's file inventory. Attribution: pre-existing repo lint debt or
the concurrently-editing agent's files (`run-detail-screen.tsx` matches the
brief's warning about the other in-progress work) — **not this change**.

Scoped lint — `npx eslint` on exactly the files this round touched (5
production files can't be linted individually meaningfully since ESLint's
flat config needs the whole tree, so this was covered by the whole-repo run
above; the 6 test files were also re-checked individually): **0 errors, 0
warnings**.

## 3. Test files updated

### `quixlab-embed.test.tsx`, `signals-selection.test.tsx`
Import fix only (§1). Behavioural assertions unchanged — same origin check,
same token-posted-to-`origin`, same silent-until-token-arrives, same single
iframe node — because `QuixLabFrame`'s handshake is byte-for-byte what the
panel's old local copy did (architecture.md "The shared handshake").

### `quixlab-open.test.tsx`
Rewrote the sidebar-specific sections. `describe("the sidebar QuixLab
control", ...)` (asserted a `button` role + `window.open`) became `describe("the
sidebar QuixLab link", ...)`: link to `/quixlab`, no `target`, no
`window.open` on click, and a new case for the active state (`aria-current=
"page"` when `usePathname()` is `/quixlab` — architecture.md "same active
state ... as every registry row"). `describe("the sidebar QuixLab control
opens the Portal", ...)` (asserted a click opened `portal_embedded_url` in a
tab) is now `describe("the sidebar QuixLab link ignores the Portal embedded
view", ...)`: proves the row stays `href="/quixlab"` and opens nothing
regardless of what `listQuixLabs` answers, because `portal_embedded_url` is a
tab-only field a Link never reads (architecture.md "A frame always loads
`embed_url`, never `portal_embedded_url`"). The `openQuixLab()` function-level
tests (unaffected — still the tab opener for run/file headers and the panel's
"Open in a tab") are untouched.

### `lakehouse-link.test.tsx`
Full rewrite: was asserting `href` equals the API's URL with `target=
"_blank"` and `rel="noreferrer noopener"`; now asserts `href="/lakehouse"`,
no `target`, row absent on an empty/failed `getLakehouseUrl()` answer
(architecture.md "url === '' means no page, empty state"), plus an added
active-state case.

### `new-tab-marks.test.tsx`
The Analysis-row cases (`marks the QuixLab row`, `marks the Lakehouse row`)
inverted to negative assertions: both rows now carry **no** `NewTabMark` —
they frame their target, they don't leave the app. Swagger footer case is
unchanged (still `target="_blank"`, still the one remaining marked sidebar
link). The old "drops the icon on the collapsed rail" case used the QuixLab
row as its subject; that subject no longer carries a mark to drop, and
re-reading `sidebar.tsx:351` shows the Swagger footer (the only marked link
left) is inside `{!collapsed && (...)}` — it disappears entirely on the rail,
it doesn't shrink to an icon. Replaced with a case that pins that: the
Swagger link is absent on the collapsed rail.

### `lakehouse-late-token.test.tsx` — not on ArchDev's "still pass unchanged"
list, but it broke
`npm run test:components` failed here first:
```
AssertionError: expected '/lakehouse' to be 'https://portal.dev.quix.io/lakehouse?…'
Expected: "https://portal.dev.quix.io/lakehouse?workspace=quixdev-testmanagerdemo-dev"
Received: "/lakehouse"
```
The test asserted `href` equals the URL `getLakehouseUrl()` answers — true
under the old tab-anchor sidebar, false under the new Link, where that URL only
gates the row's *visibility* (architecture.md: "The row's VISIBILITY depends
on this async value"), never its `href`. This is a test-authoring gap in the
handoff checklist, not a production defect: I fixed the assertion to
`href === "/lakehouse"` and kept the file's actual point (the row appears once
a late-landing Portal token resolves the URL). Flagging because the brief's
"should still pass unchanged" list should have named this file.

## 4. Test added

`tests/components/quixlab-screen.test.tsx` — renders `QuixLabScreen` with
`listQuixLabs` resolving one deployment row that carries both `embed_url` and
`portal_embedded_url`, and asserts the mounted iframe's `src` equals
`embed_url` and is never `portal_embedded_url`; a second case asserts the "No
QuixLab" empty state when the list resolves empty. Validates architecture.md
"The two pages": `/quixlab` -> `workspaceQuixLab(rows)` -> `<QuixLabFrame
embedUrl={lab.embed_url} origin={lab.origin} fill />`.

## 5. Suite runs

`npm run test:components` (vitest, `vitest.components.config.ts`): **115
files / 927 tests, all green** (after the `lakehouse-late-token.test.tsx` fix
in §3; first run had 1 failure there).

`npm run test:unit` (vitest, `vitest.unit.config.ts`): **90 files pass, 2
fail** (941 pass, 2 fail, 2 expected-fail, 945 total):

```
tests/unit/filters-pagination.test.ts > listSignals filters > sorts by name asc when explicitly requested (matches server default direction)
tests/unit/lake-partitions.test.ts > the split the two pickers read > falls back to this estate's own shape when neither is set
```

Neither test touches QuixLab, Lakehouse, the sidebar, or any of the 11
architecture-doc files.

`lake-partitions.test.ts` is explained: `git diff -- frontend/lib/explore/
lake-partitions.ts` shows the concurrently-editing agent removed
`test_definition` from `DEFAULT_SESSION_PARTITIONS` while this round was in
flight — that edit landed on disk between my typecheck run and my unit-suite
run. Not this change; the other agent's in-progress work, mid-edit.

`filters-pagination.test.ts` is not explained the same way: `git diff --stat
-- frontend/lib/mock/db.ts` is empty, the file is byte-identical to `HEAD`,
so `listSignals`'s sort comparator is unchanged. Filed below as genuinely
pre-existing, `Root cause layer: unclear`, for separate triage.

## 6. Browser check

`npm run dev` exited immediately: a Next dev server was already running on
`:3000` (PID reported by Next as already-owned, not started by me). I did not
start or stop it — used it as-is via Playwright, since it answered `200` on
`/quixlab`.

Both `/quixlab` and `/lakehouse`:
- render the shell (sidebar, topbar) correctly;
- show **no** Analysis section in the sidebar at all — `quixLabConfigured()`
  is false in this local session (no `TM_QUIXLAB_URL` reached this process),
  matching architecture.md's "no URL, no controls" rule;
- the content area shows "Resolving the workspace QuixLab…" /
  "Resolving the Lakehouse…" and never advances, because `listQuixLabs()` /
  `getLakehouseUrl()` both 401 with no Portal token, and a sign-in dialog
  ("Sign in to Test Manager", PAT textbox) sits over the page;
- one `<iframe>` never mounts, because the screens correctly refuse to frame
  anything before a URL resolves — this is the `undefined`/`null` branch of
  each screen's state machine, not the `QuixLabFrame` branch.

I did not paste a token to push past this, per the brief's constraint. This is
the expected shape for an unauthenticated local session, not a bug.

**Exact procedure needed for the deployed check** (cannot be done from this
sandbox):
1. Standalone: sign in with a real PAT, confirm the sidebar Analysis section
   appears (QuixLab, and Lakehouse if `GET /integrations/lakehouse-url`
   answers non-empty), click into `/quixlab` and confirm the frame completes
   the token handshake with **no** "QuixLab asked for a sign-in token and this
   browser holds none yet" banner, and into `/lakehouse` and confirm the
   Portal Lakehouse page renders logged in (no second sign-in prompt inside
   the frame).
2. Embedded inside the Portal-hosted Test Manager: same two checks, but via
   the Portal's own token handshake rather than a pasted PAT — this is the
   path `usePortalAuth`'s postMessage handshake serves and the local
   standalone check cannot exercise at all.

## 7. Bugs

### Bug 1.1: `lake-partitions.test.ts` fails against the concurrently-editing agent's in-flight change

**Test:** `tests/unit/lake-partitions.test.ts > the split the two pickers read > falls back to this estate's own shape when neither is set`
**Spec reference:** N/A — this test exercises `frontend/lib/explore/
lake-partitions.ts`, not anything in `dev-planning/tm-framed-integrations/
architecture.md`.
**Expected:** `sessionTreeColumns()` falls back to `["platform", "work_order", "test_definition", "run_id"]`.
**Actual:** `["platform", "work_order", "run_id"]`.
**Reproduction:** `cd frontend && npm run test:unit`
**Root cause layer:** unclear (not this change)
**Suspected root cause:** `git diff -- frontend/lib/explore/lake-partitions.ts`
shows `test_definition` was just removed from `DEFAULT_SESSION_PARTITIONS` —
the other agent's uncommitted, in-progress edit (per this brief's "another
ArchDev is concurrently editing OTHER frontend/ files" note), landed on disk
mid-round.
**Suggested fix:** not mine to fix or judge; whichever agent owns that file
should update its own test, or this is expected transient breakage while that
work is unfinished.

### Bug 1.2: `filters-pagination.test.ts` fails with no dirty backing source

**Test:** `tests/unit/filters-pagination.test.ts > listSignals filters > sorts by name asc when explicitly requested (matches server default direction)`
**Spec reference:** N/A — this test exercises `frontend/lib/mock/db.ts`'s
`listSignals`, not anything in `dev-planning/tm-framed-integrations/
architecture.md`.
**Expected:** signals sorted `asc` by name equal the plain JS `.sort()` of
their own names.
**Actual:** two names (`Chamber_Ambient_Temp`, `Chamber_Humidity`) land mid-list
instead of first; see the diff in §5.
**Reproduction:** `cd frontend && npm run test:unit`
**Root cause layer:** unclear
**Suspected root cause:** `git diff --stat -- frontend/lib/mock/db.ts` is
empty — the file is byte-identical to `HEAD` — so this predates both this
change and the concurrent agent's edits. Genuinely pre-existing.
**Suggested fix:** out of scope for this round; recommend a separate Tester
pass once this test's owning feature is identified.

No other bugs. Everything in scope for `tm-framed-integrations` — typecheck,
lint, and both test suites for the files this change actually touches — is
green.
