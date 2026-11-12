import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInboxStore,
  createSessionStarter,
  openLinear,
  type AcceptedLinearEvent,
  type LinearClient,
} from "../src/linear";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const commentId = "bac3f259-220f-4671-a193-42c764c92f23";

function session() {
  return {
    id: "session",
    url: "https://linear.app/team/issue/ENG-1/example",
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    creator: { id: "human" },
    appUser: { id: "app", organization: { id: "org" } },
    issue: {
      id: "issue",
      identifier: "ENG-1",
      title: "Explain the screenshot",
      description: "Review this image.",
    },
    sourceComment: {
      id: commentId,
      body: "Which option is accessible? ![screen](https://uploads.linear.app/org/image.png)",
    },
    comment: { id: "generated-thread", body: "" },
  };
}

async function setup(options: { fail?: boolean; returned?: unknown } = {}) {
  const { db, close } = await tempStore();
  const store = createInboxStore(db);
  const calls: { query: string; variables: unknown; signal: AbortSignal | undefined }[] = [];
  const seen: AcceptedLinearEvent[] = [];
  const client: LinearClient = {
    async query(query, variables, request) {
      calls.push({ query, variables, signal: request?.signal });
      const operation = query.includes("agentSessionCreateOnComment")
        ? "agentSessionCreateOnComment"
        : "agentSessionCreateOnIssue";
      return { [operation]: { success: true, agentSession: options.returned ?? session() } };
    },
  };
  const start = createSessionStarter({
    client,
    store,
    appUserId: "app",
    async onEvent(event) {
      seen.push(event);
      expect(await store.get(event.dedupeKey)).toEqual(event);
      if (options.fail) throw new Error("interrupted intake");
    },
  });
  return { db, close, store, start, calls, seen };
}

test("explicit issue creation persists authoritative context and links Linear to its Paws conversation", async () => {
  const env = await setup();
  const signal = new AbortController().signal;
  expect(
    await env.start({ kind: "issue", id: "ENG-1" }, "http://127.0.0.1:8787/dashboard/", signal),
  ).toEqual({ id: "session", url: "https://linear.app/team/issue/ENG-1/example" });
  expect(env.calls[0]?.variables).toEqual({
    input: {
      issueId: "ENG-1",
      externalUrls: [{ label: "Paws", url: "http://127.0.0.1:8787/dashboard/" }],
    },
  });
  expect(env.calls[0]?.signal).toBe(signal);
  expect(env.calls[1]?.query).toContain("agentSessionUpdate");
  expect(env.calls[1]?.variables).toEqual({
    id: "session",
    input: {
      externalUrls: [{ label: "Paws", url: "http://127.0.0.1:8787/dashboard/issues/ENG-1" }],
    },
  });
  expect(env.seen).toHaveLength(1);
  const payload = JSON.parse(env.seen[0]!.payload);
  expect(payload).toMatchObject({
    appUserId: "app",
    organizationId: "org",
    agentSession: { creator: { id: "human" } },
  });
  expect(payload.promptContext).toContain("Explain the screenshot");
  await Promise.resolve();
  await env.start({ kind: "issue", id: "ENG-1" }, "http://127.0.0.1:8787/dashboard/");
  expect(env.seen).toHaveLength(1);
  await env.close();
});

test("comment creation keeps selected thread text and assets and interrupted intake replays", async () => {
  const env = await setup({ fail: true });
  await env.start({ kind: "comment", id: commentId }, "http://localhost/dashboard/");
  expect(env.calls[0]?.query).toContain("$input: AgentSessionCreateOnComment!");
  expect(env.calls[0]?.variables).toMatchObject({ input: { commentId } });
  await Promise.resolve();
  const replay = await createInboxStore(env.db).listUnhandled();
  expect(replay).toHaveLength(1);
  expect(JSON.parse(replay[0]!.payload).promptContext).toContain(
    "uploads.linear.app/org/image.png",
  );
  expect(replay[0]?.dedupeKey).toBe("session:session:created");
  await env.close();
});

test("wrong app, mismatched thread and unsuccessful mutation never enter intake", async () => {
  for (const returned of [
    { ...session(), appUser: { id: "other" } },
    { ...session(), issue: null },
    { ...session(), sourceComment: null },
  ]) {
    const env = await setup({ returned });
    await expect(
      env.start({ kind: "comment", id: commentId }, "http://localhost/dashboard/"),
    ).rejects.toThrow();
    expect(await env.store.listUnhandled()).toHaveLength(0);
    expect(env.seen).toHaveLength(0);
    await env.close();
  }
});

test("production explicit session intake stays pending when follow-up fails and replays after restart", async () => {
  const { db, close } = await tempStore();
  const secretsDir = join(tempHome(), "secrets");
  mkdirSync(secretsDir, { recursive: true });
  const attempts: string[] = [];
  const fetchImpl = async (_url: string | URL | Request, input?: RequestInit) => {
    const body = JSON.parse(String(input?.body)) as { query: string };
    return Response.json({
      data: body.query.includes("agentSessionCreateOnIssue")
        ? { agentSessionCreateOnIssue: { success: true, agentSession: session() } }
        : { agentActivityCreate: { success: true, agentActivity: { id: crypto.randomUUID() } } },
    });
  };
  const first = await openLinear({
    db,
    store: db,
    secretsDir,
    env: { LINEAR_ACCESS_TOKEN: "host-only-token" },
    fetch: fetchImpl,
    async followUp() {
      attempts.push("failed");
      throw new Error("interrupted intake");
    },
  });
  await first.startSession!({ kind: "issue", id: "ENG-1" }, "http://127.0.0.1/dashboard/");
  for (let attempt = 0; attempt < 50 && attempts.length === 0; attempt++) await Bun.sleep(1);
  await Bun.sleep(5);
  const reopened = createInboxStore(db);
  expect(await reopened.listUnhandled()).toHaveLength(1);
  const second = await openLinear({
    db,
    store: db,
    secretsDir,
    env: { LINEAR_ACCESS_TOKEN: "host-only-token" },
    fetch: fetchImpl,
    async followUp() {
      attempts.push("recovered");
    },
  });
  const running = await second.start();
  await running.catchUp();
  for (let attempt = 0; attempt < 50 && (await reopened.listUnhandled()).length > 0; attempt++)
    await Bun.sleep(1);
  running.stop();
  expect(await reopened.listUnhandled()).toHaveLength(0);
  expect(attempts).toEqual(["failed", "recovered"]);
  await close();
});
