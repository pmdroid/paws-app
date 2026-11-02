import { expect, test } from "bun:test";
import { GENERATED_AT_HEADER, OVERVIEW_API_PATH, parseOverviewResponse } from "../contract";
import { emptyOverview } from "../live/overview";
import { createResourceReader } from "./resource-reader";

const FIRST = "2026-11-02T10:00:00.000Z";
const LATER = "2026-11-02T10:00:05.000Z";

test("the overview reader asks with the last ETag, keeps the body on 304 and forgets it on sign-out", async () => {
  const sent: Array<{ path: string; etag: string | null }> = [];
  const replies: Response[] = [
    Response.json(emptyOverview(new Date(FIRST)), { headers: { ETag: 'W/"one"' } }),
    new Response(null, { status: 304, headers: { [GENERATED_AT_HEADER]: LATER } }),
    new Response(JSON.stringify({ error: "sign in" }), { status: 401 }),
    Response.json({ ...emptyOverview(), issues: "none" }),
  ];
  const resources = createResourceReader(async (path, init) => {
    sent.push({ path, etag: new Headers(init.headers).get("If-None-Match") });
    return replies.shift()!;
  });
  const parse = (input: unknown) => {
    const parsed = parseOverviewResponse(input);
    return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
  };
  const reader = { read: () => resources.read(OVERVIEW_API_PATH, "member", parse) };

  const first = await reader.read();
  expect(first.kind === "loaded" && first.body.generatedAt).toBe(FIRST);
  const second = await reader.read();
  expect(second.kind === "loaded" && second.body).toEqual({
    ...emptyOverview(new Date(FIRST)),
    generatedAt: LATER,
  });
  resources.clear();
  const third = await reader.read();
  expect(third.kind === "response" && third.response.status).toBe(401);
  await expect(reader.read()).rejects.toThrow("overview.issues must be an array");
  expect(sent).toEqual([
    { path: OVERVIEW_API_PATH, etag: null },
    { path: OVERVIEW_API_PATH, etag: 'W/"one"' },
    { path: OVERVIEW_API_PATH, etag: null },
    { path: OVERVIEW_API_PATH, etag: null },
  ]);
});
