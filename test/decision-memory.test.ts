import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeDecision,
  confirmDecision,
  suggestDecisions,
  listDecisions,
  decisionAnswers,
} from "../src/decisions";
import { openQuestion, answer, ask } from "../src/questions";
import { decisionFixture, probeDecisionMemory } from "./local/decision-memory";

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
  const f = decisionFixture(root);
  try {
    const asker = { itemId: "controlled", runId: f.runId, sessionId: "session-controlled" };
    for (const kind of ["runner-wait", "repository", "clarification"] as const) {
      ask(f.db, asker, kind, `${kind} question`, { now: Date.now() });
      answer(f.db, {
        sessionId: "session-controlled",
        deliveryId: kind,
        body: `${kind} answer`,
        answeredBy: "member",
      });
    }
    const actor = { workspaceId: "workspace", userId: "member", clientId: "client" };
    expect(
      decisionAnswers(f.db, actor)
        .map((row) => row.body)
        .toSorted(),
    ).toEqual(["Which pagination format?", "clarification question"]);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent confirmations accept one suggestion once, with every read inside a transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-confirm-decision-"));
  const f = decisionFixture(root);
  const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
  try {
    const actor = { workspaceId: "workspace", userId: "member", clientId: "client" };
    changeDecision(
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
    const pending = openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "Which pagination format?",
    });
    const suggestion = suggestDecisions(f.db, pending.id, pending.body)[0]!;
    const query = f.db.query.bind(f.db);
    const transactions: boolean[] = [];
    f.db.query = ((...args: Parameters<typeof f.db.query>) => {
      transactions.push(f.db.inTransaction);
      return query(...args);
    }) as typeof f.db.query;
    expect(() =>
      confirmDecision(f.db, pending.id, suggestion.value, "inactive", Date.now()),
    ).toThrow();
    f.db.query = query;
    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every(Boolean)).toBe(true);
    const script = `
      import { Database } from "bun:sqlite";
      import { confirmDecision } from ${JSON.stringify(join(process.cwd(), "src/decisions/index.ts"))};
      const db = new Database(process.argv[1]);
      db.run("PRAGMA busy_timeout=5000");
      console.log("ready");
      for await (const _ of Bun.stdin.stream()) break;
      try {
        confirmDecision(db, process.argv[2], process.argv[3], "member", Number(process.argv[4]));
        console.log("accepted");
      } catch (error) { console.log(error.message); process.exitCode = 2; }
      finally { db.close(); }
    `;
    const outputs = [];
    for (const at of [100, 200]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          script,
          join(root, "controls.sqlite"),
          pending.id,
          suggestion.value,
          String(at),
        ],
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
    expect(listDecisions(f.db, actor)[0]?.accepted).toBe(1);
    expect(() => confirmDecision(f.db, pending.id, suggestion.value, "member", 300)).toThrow();
    const accepted = f.db
      .query<{ accepted_at: number }, []>(
        "SELECT accepted_at FROM decision_suggestion WHERE accepted_at IS NOT NULL",
      )
      .get();
    expect(accepted).not.toBeNull();
    expect([100, 200]).toContain(accepted!.accepted_at);
  } finally {
    for (const child of children) child.kill();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
