# Paws status

Read-only status for a local Paws engine: epics, items and their states, current runs, open questions, Closeout verdicts, and the merge queue.

The engine cannot run on Vercel. This directory is a static site plus a small HTTP stub the local process mounts on loopback. It imports nothing else under `src`.

## Contract

`GET /api/status` returns one JSON object, `StatusSnapshot` in [`src/contract.ts`](src/contract.ts).

- `version` is `1`.
- `source` is `"demo"` for the sample stub and `"live"` when the engine built the body from its own state.
- `questions` lists open questions only. The page does not answer them.
- Unknown fields are ignored. The parser rejects a body that does not match.

Example:

```json
{
  "version": 1,
  "source": "demo",
  "generatedAt": "2026-10-09T22:15:00.000Z",
  "project": { "name": "Platform", "team": "ENG", "repo": "acme/platform", "workspace": "acme" },
  "epics": [],
  "items": [],
  "runs": [],
  "questions": [],
  "verdicts": [],
  "mergeQueue": [],
  "events": []
}
```

`fakeStatusProvider()` is exported from [`index.ts`](index.ts) and returns the fictional acme / ENG snapshot. The server mounts it like this:

```ts
import { handleStatusRequest, fakeStatusProvider } from "../web";

const response = await handleStatusRequest(request, {
  provider: fakeStatusProvider(), // replace with a reader over engine state
});
if (response) return response;
```

`null` means the request is not `/status` or `/api/status`. Leave webhook routes alone.

The process binds `127.0.0.1`. `GET /api/status` responds with `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`, so a static deployment can poll a tunnel of that route. HTML served by the process gets `<base href="/status/">` so relative assets resolve. The Vercel build does not include that tag.

## Local

From the repo root:

```bash
bun install
bun run build:status
bun run paws
```

- Page: http://127.0.0.1:8787/status
- API: http://127.0.0.1:8787/api/status

When the page is served under `/status`, it calls the same origin's `/api/status`. The stub's body is still `source: "demo"`, and the page says so.

## Vercel

`vercel.json` at the repo root is the static-site config. From the repo root:

```bash
vercel deploy --prod
```

The build runs `bun run build:status` and publishes `src/web/dist` only. It does not start the engine. With no engine URL, the site shows the bundled demo snapshot and a demo label.

To bake a default engine origin:

```bash
PAWS_ENGINE_URL=https://<tunnel-host> vercel deploy --prod
```

Visitors can also set the origin in the Engine control (stored in the browser) or open:

```text
https://<deployment>/?engine=https://<tunnel-host>
```

`?engine=demo` forces the sample snapshot. The saved value is an `http` or `https` URL; the page requests `GET /api/status` on that origin and sends `ngrok-skip-browser-warning` so a free ngrok tunnel can answer.

## Check

```bash
bun run check
```

That runs oxlint, oxfmt, `tsc` (engine plus the browser client), the tests, and the static build.
