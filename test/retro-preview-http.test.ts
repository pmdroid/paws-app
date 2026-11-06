import { expect, test } from "bun:test";
import { createRetroPreviewHttp, DEFAULT_RETRO_PROMPT } from "../src/retros";
import { ALL, ONLY_A, world } from "./improvement-fixtures";

function fixture() {
  const w = world();
  const handle = createRetroPreviewHttp({ db: w.db, artifactRoot: w.root, now: () => 9 });
  const call = async (
    who: string,
    path: string,
    body?: unknown,
    sessions: readonly string[] = who === "admin" ? ALL : ONLY_A,
  ) => {
    const response = await handle(
      new Request(`http://paws.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      w.people[who]!,
      sessions,
    );
    if (response === null) return null;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const denials = () =>
    w.db
      .query<{ subject: string }, []>(
        "SELECT subject FROM workspace_access_audit WHERE action = 'access.denied' ORDER BY id",
      )
      .all()
      .map((row) => row.subject);
  return { w, call, denials };
}

test("an admin previews the unsaved draft against a sample when no digest is readable", async () => {
  const { call } = fixture();
  const answer = await call(
    "admin",
    "/api/retros/preview",
    {
      prompt: "Draft for {{period}} with up to {{max_items}}.\n\n{{digest}}",
      outputLimits: { maxItems: 2, workedWell: 1 },
    },
    [],
  );
  expect(answer!.status).toBe(200);
  expect(answer!.body.text).toContain("Draft for");
  expect(answer!.body.text).toContain("up to 2");
  expect((answer!.body.source as { kind: string }).kind).toBe("sample");
  expect(answer!.body.label).toContain("Preview only");
});

test("preview reports a malformed draft beside the editor and refuses members", async () => {
  const { call, denials } = fixture();
  const invalid = await call("admin", "/api/retros/preview", {
    prompt: "No digest {{nope}}",
    outputLimits: { maxItems: 5, workedWell: 3 },
  });
  expect(invalid).toEqual({
    status: 400,
    body: { error: "Unknown variable: nope.", reason: "invalid" },
  });
  const member = await call("ada", "/api/retros/preview", {
    prompt: DEFAULT_RETRO_PROMPT,
    outputLimits: { maxItems: 5, workedWell: 3 },
  });
  expect(member!.status).toBe(403);
  expect(denials()).toEqual(["/api/retros/preview"]);
  expect((await call("admin", "/api/retros/preview"))!.status).toBe(405);
});

test("a retro's frozen settings show the prompt and resolved profile it ran with", async () => {
  const { call } = fixture();
  const answer = await call("admin", "/api/retros/reports/r1/settings");
  expect(answer!.status).toBe(200);
  expect(answer!.body).toMatchObject({
    retroId: "r1",
    settingsRevision: 1,
    prompt: "Review {{period}}.\n\n{{digest}}",
    agentProfile: { agent: "codex" },
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: 1 },
  });
});

test("frozen settings need full access and stay hidden outside the workspace", async () => {
  const { call, denials } = fixture();
  const partial = await call("ada", "/api/retros/reports/r1/settings");
  expect(partial!.status).toBe(403);
  expect(partial!.body.reason).toBe("partial_access");
  expect(denials()).toEqual(["/api/retros/reports/r1/settings"]);
  expect((await call("admin", "/api/retros/reports/nope/settings"))!.status).toBe(404);
  expect(await call("admin", "/api/retros/reports/r1/prompt")).toBeNull();
});
