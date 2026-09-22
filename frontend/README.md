# Test Manager front end

A [Next.js](https://nextjs.org) application. It reads the Test Manager API.

## Run it with the whole system

The local stack runs this front end as a compose service, beside a real
QuixLake, MongoDB, the API, the planning mock and a one-shot seed. One command
starts every part, and a code change needs no rebuild.

**`../docs/LOCAL-STACK.md` is the one place that holds the command.** This file
does not repeat it.

The front end then answers on **`http://localhost:3001`**, or on the port you
set in `TM_FRONTEND_PORT`. **The default is not 3000.** Port 3000 belongs to
Grafana on the build machine.

## Run only the front end

Use this when you work on a screen and you need no backend.

```bash
npm run dev
```

It serves the built-in **mock** handlers under `app/api/v1/`, so a green screen
proves nothing about the backend. Read the next section before you trust one.

## The three variables that point this application at the API

Compose sets all three. Set them yourself only when you run outside compose.
A wrong one fails quietly.

| Variable | What it does |
|---|---|
| `API_URL` | **The one that matters.** The server-side proxy at `app/api/proxy/[...path]/route.ts:15` reads it, and every browser call goes through that proxy (`lib/api/client.ts:7`). Unset, the proxy calls **itself** and serves nothing. `app.yaml:4` names the same variable, so local and deployed agree. |
| `TM_BE_URL` | A different job. `next.config.ts:12-13` rewrites `/api/v1/*` to the backend when it is set. Unset, the built-in mock handlers answer instead. Never set this one alone. |
| `TM_API_TOKEN` | The proxy adds the bearer header (`route.ts:19-20`). Without it every screen answers 401. |

**The token stays on the server.** No name carries a `NEXT_PUBLIC_` prefix, so
Next.js never puts the token in a browser bundle.

`.env.local` still works, and the compose bind mount carries it into the
container. The compose `environment:` block wins over it.

## The three variables that point this application at the lake

The Explore workbench and the sessions picker read QuixLake directly, through
this server's own `/api/lake/*` handlers. Three variables describe what they
find there. All three reach the **server** process only; `app/layout.tsx` reads
them at request time and `LakeConfigProvider` hands them to the browser code,
so no `NEXT_PUBLIC_` name exists and `next build` bakes nothing into the image.

| Variable | What it does |
|---|---|
| `TM_LAKE_TABLE` | The PHYSICAL table every Explore surface names and every generated statement uses (`lib/explore/lake-schema.ts`). Unset, the local stack's `test_signal_samples` applies. |
| `TM_LAKE_SESSION_PARTITIONS` | The partition levels that **address a session**, outermost first; the last one IS the session. The sessions dialog walks these folders and lists that last level's values as the sessions. Unset, `platform,work_order,test_definition,run_id`. |
| `TM_LAKE_DATA_PARTITIONS` | The partition levels **inside one session**, outermost first; the last one is the signal. The Explorer's tree walks these under a picked session, and an issue's link names its signal by them. Unset, `protocol,~bus,~stream,~fcc,~signal`. |

The last two are the sink's own `HIVE_COLUMNS` (`lake-sink/app.yaml`), split at
the session level — a `~` virtual marker is accepted and ignored, so the sink's
value can be pasted and cut in two. Nothing in the tree says where that cut is,
and the two pickers read different halves of it, which is why the split is
stated rather than guessed. An estate shaped another way states its own names
(`site,rig,session` over `channel,signal`) and both pickers follow, with no
code change.

## Hot reload inside Docker

`next.config.ts` reads `TM_WATCH_POLL_MS` and sets `watchOptions.pollIntervalMs`.
Turbopack watches files through the operating system, and Docker Desktop does not
deliver a Windows bind-mount event into a Linux container. Compose therefore sets
`TM_WATCH_POLL_MS: ${TM_WATCH_POLL_MS:-1000}`. **Unset it on Linux or macOS.**
The operating system delivers the event there, and the poll then costs processor
time for nothing.

## The development image

`Dockerfile.dev` builds on `node:20-bookworm-slim`. **It installs no global npm
package, and that is deliberate.** The image used to run `npm install -g
npm@latest`. That floating tag now resolves to npm 12, which refuses node 20, so
the image build failed on 18 Aug 2026. The step is deleted. `typescript` and
`@types/node` are already devDependencies, so the local `npm install` supplies
both. **Never add a global install back.**

The compose service mounts `./frontend` over `/app`, and it keeps the image's
own `node_modules` and `.next` with two anonymous mounts. A plain bind mount
would hide `node_modules` and would push a Windows-built `.next` cache into
Linux.

## The contract guard

```bash
npm run test:contract
```

It replays the 28 golden requests from `../api/tests/golden_requests.json`
against the committed snapshot `../api/docs/openapi.v1.json`. The PR build runs
it. When it fails, fix the drift. Never edit the failing test. Known drift lives
in `KNOWN_DRIFT` in `tests/contract.golden.test.ts`.

## Learn more

- [Next.js Documentation](https://nextjs.org/docs)
- `AGENTS.md` in this directory — read it before you write code here.
