import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openPawsStore, type Db } from "../db";
import { setJournalSink } from "../journal";
import { verifyRunnerRetroCommand } from "../runner-protocol";
import { addRunnerPg, heldAccountBindings, trustedKeys, worldPg } from "./dispatch.fixtures";
import { FIXTURE_END, FIXTURE_START } from "./result.fixtures";
import { seed, withoutForeignKeys } from "../../test/pglite-fixtures";
import { copyMigratedPglite } from "../../test/pglite";

const TOKEN = `ghp_${"a1".repeat(18)}`;
const SECRET = "planted-secret-value";
const line = (ms: number, event: object) =>
  JSON.stringify({ t: new Date(FIXTURE_START + ms).toISOString(), event });
const say = (text: string) => ({
  type: "session_update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const tool = (update: object) => ({
  type: "session_update",
  update: { toolCallId: "t1", title: "Bash", ...update },
});
const TRANSCRIPT = [
  say("Checking the "),
  say(`branch with ${SECRET} ü`),
  tool({ sessionUpdate: "tool_call", rawInput: { command: "git push" } }),
  tool({ sessionUpdate: "tool_call_update", status: "failed", rawOutput: `rejected ${TOKEN}` }),
  { type: "prompt_complete", stopReason: "end_turn" },
  { type: "error", message: "The agent stopped." },
]
  .map((event, index) => line(index, event))
  .join("\n");

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function reopen(root: string) {
  const opened = await openPawsStore({ url: null, pgliteDir: join(root, "pglite") });
  return { db: opened.store, close: opened.close };
}

const runs = [
  { id: "run-a", workspaceId: "ws", createdAt: FIXTURE_START + 1_000 },
  { id: "run-broken", workspaceId: "ws", createdAt: FIXTURE_START + 2_000 },
  { id: "run-late", workspaceId: "ws", createdAt: FIXTURE_END + 1_000 },
  { id: "run-foreign", workspaceId: "other", createdAt: FIXTURE_START + 3_000 },
];

async function started() {
  const world = await worldPg(
    {
      open: async (root) => {
        await copyMigratedPglite(join(root, "pglite"));
        return reopen(root);
      },
      reopen,
    },
    {
      before: async (db) => {
        await withoutForeignKeys(db);
        await seed(
          db,
          (q) =>
            q.orm.insert(q.t.run).values(
              runs.map((run) => ({
                id: run.id,
                itemId: "item-PAS-817",
                kind: "implement" as const,
                agent: "codex",
                status: "ended",
                createdAt: run.createdAt,
                updatedAt: run.createdAt + 500,
              })),
            ),
          (q) =>
            q.orm.insert(q.t.runnerTranscript).values(
              runs.map((run) => ({
                runId: run.id,
                generation: 1,
                commandId: `command-${run.id}`,
                workspaceId: run.workspaceId,
                executionId: "e",
                sizeBytes: TRANSCRIPT.length,
                sealedSize: TRANSCRIPT.length,
              })),
            ),
        );
      },
    },
  );
  roots.push(world.root);
  closes.push(() => world.close());
  const reader = {
    async download(runId: string) {
      if (runId === "run-broken") throw new Error("sealed object failed to open");
      return new TextEncoder().encode(TRANSCRIPT);
    },
  };
  const extra = { transcripts: reader, secrets: [SECRET] };
  await addRunnerPg(world.db, { id: "R1" });
  await seed(world.db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: world.clock.now }));
  let dispatcher = world.open(world.db, undefined, extra);
  await dispatcher.tick();
  const listed = await call(dispatcher, "/v1/retro-commands");
  const command = (listed.body.commands as unknown[])
    .map((envelope) =>
      verifyRunnerRetroCommand(envelope, {
        trustedKeys,
        runnerId: "R1",
        workspaceId: "ws",
        now: world.clock.now,
        accountBindings: heldAccountBindings("R1"),
        latestAttempt: () => undefined,
        claimCommand: () => true,
      }),
    )
    .flatMap((verified) => (verified.ok ? [verified.command] : []))[0]!;
  expect(command.transcripts).toBeUndefined();
  expect((await call(dispatcher, `/v1/retro-commands/${command.id}/ack`, {})).status).toBe(200);
  const read = (body: Record<string, unknown>) =>
    call(dispatcher, `/v1/retro-commands/${command.id}/input`, {
      commandId: command.id,
      workspaceId: "ws",
      retroId: "r1",
      attempt: command.attempt,
      kind: "transcript",
      runId: "run-a",
      generation: 1,
      offset: 0,
      limit: 32 * 1024,
      ...body,
    });
  const restart = async () => {
    const db = await world.restart();
    dispatcher = world.open(db, undefined, extra);
    return db;
  };
  return { world, read, restart };
}

type Dispatcher = ReturnType<Awaited<ReturnType<typeof worldPg>>["open"]>;

async function call(dispatcher: Dispatcher, path: string, body?: unknown) {
  const request =
    body === undefined
      ? new Request(`https://runner.test${path}`)
      : new Request(`https://runner.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
  const response = (await dispatcher.fetch(request, "R1"))!;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function setBudget(db: Db, reads: number, bytes: number) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.retroAttempt)
      .set({ transcriptReads: reads, transcriptBytes: bytes })
      .where(eq(q.t.retroAttempt.retroId, "r1")),
  );
}

test("an authorized read returns the redacted rendered range in pieces", async () => {
  const journal: string[] = [];
  const restore = setJournalSink((entry) => journal.push(entry));
  try {
    const { read } = await started();
    const whole = await read({});
    expect(whole.status).toBe(200);
    const text = whole.body.text as string;
    expect(text).toContain("agent: Checking the branch with [redacted] ü");
    expect(text).toContain('tool Bash: {"command":"git push"}');
    expect(text).toContain("tool Bash failed: rejected");
    expect(text).toContain("turn end: end_turn");
    expect(text).toContain("error: The agent stopped.");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    const total = whole.body.total as number;
    expect(whole.body).toMatchObject({ offset: 0, nextOffset: total });
    let joined = "";
    for (let offset = 0; offset < total;) {
      const part = await read({ offset, limit: 7 });
      expect(part.status).toBe(200);
      joined += part.body.text as string;
      offset = part.body.nextOffset as number;
    }
    expect(joined).toBe(text);
    expect(journal.some((entry) => entry.includes("retro=r1 attempt=1 run=run-a#1 bytes="))).toBe(
      true,
    );
  } finally {
    restore();
  }
});

test("runs outside the index or workspace are refused, and one unreadable run stays local", async () => {
  const { read } = await started();
  for (const runId of ["run-late", "run-foreign", "run-unknown"])
    expect((await read({ runId })).status).toBe(403);
  expect((await read({ generation: 2 })).status).toBe(403);
  const broken = await read({ runId: "run-broken" });
  expect(broken).toMatchObject({ status: 422, body: { code: "unreadable" } });
  expect((await read({})).status).toBe(200);
  expect((await read({ limit: 32 * 1024 + 1 })).status).toBe(403);
  expect((await read({ kind: "transcripts" })).status).toBe(403);
  expect((await read({ attempt: 2 })).status).toBe(409);
});

test("the per-attempt budget holds across reads and a restart", async () => {
  const { world, read, restart } = await started();
  await setBudget(world.db, 398, 0);
  expect((await read({ limit: 16 })).status).toBe(200);
  const db = await restart();
  expect((await read({ limit: 16 })).status).toBe(200);
  expect(await read({ limit: 16 })).toMatchObject({
    status: 429,
    body: { code: "transcript_budget_used" },
  });
  await setBudget(db, 0, 8 * 1024 * 1024 - 10);
  expect((await read({ limit: 10 })).status).toBe(200);
  await restart();
  expect((await read({ limit: 1 })).status).toBe(429);
});
