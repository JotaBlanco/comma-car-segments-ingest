# Framed integrations: QuixLab and the Lakehouse inside the Test Manager

## What changed

The sidebar's two Analysis entries stopped opening browser tabs. "QuixLab" and
"Lakehouse" are now ordinary Next `<Link>` rows — same active state, same rail
tooltip as every registry row — leading to `/quixlab` and `/lakehouse`, two
pages that frame their target in the content area. Nothing about the API
changed; both pages read the routes that already existed.

## The shared handshake

`frontend/components/shared/quixlab-frame.tsx` holds the frame and the whole
message dance, lifted verbatim out of the run-detail panel:

```
QuixLab (child)                    QuixLabFrame (parent)
   |  REQUEST_AUTH_TOKEN  ------->  event.origin === origin ?  (first, always)
   |                                getActivePortalToken()     (read NOW)
   |  <-------  AUTH_TOKEN          postMessage(..., origin)   (never "*")
   |  REQUEST_TM_IMPORT   ------->  runId empty -> ignored
   |  <-------  TM_IMPORT           {runId} or {runId, signals}
```

Props: `embedUrl`, `origin`, `title?`, `runId?`, `signals?`, `fill?`. The
caller passes the address and the origin its messages belong to rather than an
instance row, so the component needs nothing of the API's row shape. `runId`
defaults to empty, and an empty run id means the frame answers no
`REQUEST_TM_IMPORT`: `/quixlab` frames the workspace, not a run.

`fill` replaces the old `expanded`: the class switch is "fill the container or
keep a 600px floor", which is what the page needs and what the panel's expanded
state asked for. No `sandbox`, no `allow` — the same attributes the run-detail
and station frames carry. QuixLab needs same-origin storage for its session
cookie, and a `sandbox` without `allow-same-origin` kills it.

`components/screens/run-detail/quixlab-panel.tsx` now imports that component;
its own copy is gone. The panel keeps the picker, the outage note, "Open in a
tab" and the expand/collapse overlay.

## The two pages

```
/quixlab                                   /lakehouse
  QuixLabScreen                              LakehouseScreen
  GET /integrations/quixlabs                 GET /integrations/lakehouse-url
  workspaceQuixLab(rows)                     url
    -> first running deployment                -> "" means no page, empty state
    -> else configuredQuixLab()                -> else <iframe src={url}>
  <QuixLabFrame embedUrl={lab.embed_url}    the Portal page authenticates its
                origin={lab.origin} fill /> own viewer: no token, no message
```

Both screens take the content area edge to edge through `SHELL_BREAKOUT_CLASS`,
the constant the workbook station and the Explore split already use: a framed
app brings its own chrome, so the page adds no header and no padding.

**A frame always loads `embed_url`, never `portal_embedded_url`.** The two are
not interchangeable and the split is by surface, not by availability: a TAB
opens the Portal's embedded view, because a tab that leaves for a raw
deployment host leaves the Portal; a FRAME opens QuixLab's own `isIframe=true`
mode. The Test Manager already runs framed inside the Portal, so framing a
Portal page would nest Portal chrome inside the content area and the token
handshake would never fire — the Portal page authenticates its own viewer and
posts nothing to us. Against `embed_url` the handshake is the only thing that
gives the frame a session, and one handshake path then serves both surfaces:
`/quixlab` and the run-detail panel frame the same address the same way.

`portal_embedded_url` therefore stays what `openQuixLab` and `openQuixLabNode`
open, and the sidebar still fetches it into the module value those two read.

Each page resolves its own URL rather than reading the sidebar's: a page opened
by its address has no sidebar answer to wait for. Two GETs where there was one,
both already cached behind the viewer's Portal token wait.

## File inventory

| File | State | Why |
|---|---|---|
| `frontend/components/shared/quixlab-frame.tsx` | new | The frame and the handshake, one copy, two callers. |
| `frontend/components/screens/quixlab/quixlab-screen.tsx` | new | Resolves the workspace QuixLab and frames it. |
| `frontend/components/screens/lakehouse/lakehouse-screen.tsx` | new | Frames the Portal's Lakehouse page. |
| `frontend/app/quixlab/page.tsx` | new | Route + title. |
| `frontend/app/lakehouse/page.tsx` | new | Route + title. |
| `frontend/components/screens/run-detail/quixlab-panel.tsx` | changed | Frame extracted; the panel keeps the picker and the tab control. |
| `frontend/components/shell/sidebar.tsx` | changed | Two Links instead of a button and a `_blank` anchor; one row renderer for both groups. |
| `frontend/lib/quixlab.ts` | changed | `selectable` moved here; `workspaceQuixLab` added. |
| `frontend/lib/shell-breakout.ts` | changed | Docstring: the consumer list grew. |
| `frontend/lib/api/integrations.ts` | changed | Docstring: an empty URL now hides a row and empties a page. |
| `frontend/lib/quixlab-server.ts` | changed | Docstring: the control count was stale. |

## What was NOT deleted

`openQuixLab` stays. The sidebar was one of four callers; the run detail header
(`run-detail-screen.tsx:415`), the file detail header
(`file-detail-screen.tsx:268`) and the panel's "Open in a tab"
(`quixlab-panel.tsx`) still open tabs, and the brief's "delete it if nothing
else imports it" does not apply. `openQuixLabNode` (issue detail) is untouched.
The only `window.open` paths left in the frontend are those two functions and
`openFts`; the only `target="_blank"` left in the sidebar is the Swagger link.

## Neighbours

The Flight Test Station frame (`fts-panel.tsx`) runs the same relay with its
own origin and was left alone: it has no second caller, so extracting it would
buy nothing today. If a `/station` page ever appears, `quixlab-frame.tsx` is
the shape to copy.

The suite still encodes the tab behaviour this change replaced. See the
hand-off checklist: `quixlab-open.test.tsx`, `lakehouse-link.test.tsx`,
`new-tab-marks.test.tsx`, `quixlab-embed.test.tsx` and
`signals-selection.test.tsx` all assert against the old shape.
