import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionAnswers } from "../src/decisions";
import { answer, ask } from "../src/questions";
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
