import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeDecision, listDecisions, decisionAnswers } from "../src/decisions";
import { isNotNull } from "drizzle-orm";
import { postgresDb, type PgOrm } from "../src/db";
import { openQuestion } from "../src/questions";
import { answerPg, askPg, confirmDecisionPg, suggestDecisionsPg } from "./questions";
import { decisionFixture, probeDecisionMemory } from "./decision-memory-fixture";

function watchReads(orm: PgOrm, inTransaction: boolean, reads: boolean[]): PgOrm {
  return new Proxy(orm, {
    get(target, property) {
      if (property === "select") reads.push(inTransaction);
      if (property === "transaction")
        return (work: (tx: PgOrm) => Promise<unknown>, config?: unknown) =>
          target.transaction((tx) => work(watchReads(tx, true, reads)), config as never);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("decision memory requires accessible confirmed human answers and never resumes on a search match", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-decisions-"));
  try {
    expect(await probeDecisionMemory(root)).toHaveLength(5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only agent and clarification answers are offered as decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-decisions-"));
  const f = await decisionFixture(root);
  try {
    const asker = { itemId: "controlled", runId: f.runId, sessionId: "session-controlled" };
    for (const kind of ["runner-wait", "repository", "clarification"] as const) {
      await askPg(f.db, asker, kind, `${kind} question`, { now: Date.now() });
      await answerPg(f.db, {
        sessionId: "session-controlled",
        deliveryId: kind,
        body: `${kind} answer`,
        answeredBy: "member",
      });
    }
    const actor = { workspaceId: "workspace", userId: "member", clientId: "client" };
    expect((await decisionAnswers(f.db, actor)).map((row) => row.body).toSorted()).toEqual([
      "Which pagination format?",
      "clarification question",
    ]);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent confirmations accept one suggestion once, with every read inside a transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-confirm-decision-"));
  const f = await decisionFixture(root);
  const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
  try {
    const actor = { workspaceId: "workspace", userId: "member", clientId: "client" };
    await changeDecision(
      f.db,
      actor,
      {
        questionId: f.question.id,
        statement: f.question.answer,
        scopeGlobs: ["**"],
        tags: ["pagination"],
      },
      Date.now(),
    );
    const pending = await openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "Which pagination format?",
    });
    const suggestion = (await suggestDecisionsPg(f.db, pending.id, pending.body))[0]!;
    const transactions: boolean[] = [];
    const watched = postgresDb(watchReads(f.db.orm as PgOrm, false, transactions));
    await expect(
      confirmDecisionPg(watched, pending.id, suggestion.value, "inactive", Date.now()),
    ).rejects.toThrow();
    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every(Boolean)).toBe(true);
    const script = `
      import { confirmDecisionSteps } from ${JSON.stringify(join(process.cwd(), "src/decisions/index.ts"))};
      import { openPawsStore } from ${JSON.stringify(join(process.cwd(), "src/db/index.ts"))};
      const db = await openPawsStore({ url: process.argv[1], pgliteDir: "" });
      console.log("ready");
      for await (const _ of Bun.stdin.stream()) break;
      try {
        await db.store.transaction((q) =>
          confirmDecisionSteps(q, process.argv[2], process.argv[3], "member", Number(process.argv[4])),
        );
        console.log("accepted");
      } catch (error) { console.log(error.message); process.exitCode = 2; }
      finally { await db.close(); }
    `;
    const outputs = [];
    for (const at of [100, 200]) {
      const child = Bun.spawn(
        [process.execPath, "--eval", script, f.url, pending.id, suggestion.value, String(at)],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      children.push(child);
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      outputs.push(reader);
    }
    for (const child of children) {
      child.stdin.write("go");
      child.stdin.end();
    }
    expect((await Promise.all(children.map((child) => child.exited))).sort()).toEqual([0, 2]);
    for (const reader of outputs) reader.releaseLock();
    expect((await listDecisions(f.db, actor))[0]?.accepted).toBe(1);
    await expect(
      confirmDecisionPg(f.db, pending.id, suggestion.value, "member", 300),
    ).rejects.toThrow();
    const accepted = await f.db.run((q) =>
      q.one(
        q.orm
          .select({ acceptedAt: q.t.decisionSuggestion.acceptedAt })
          .from(q.t.decisionSuggestion)
          .where(isNotNull(q.t.decisionSuggestion.acceptedAt)),
      ),
    );
    expect(accepted).toBeDefined();
    expect([100, 200]).toContain(accepted!.acceptedAt!);
  } finally {
    for (const child of children) child.kill();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
