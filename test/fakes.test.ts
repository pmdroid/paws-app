import { describe, expect, test } from "bun:test";
import { createFakeAcpRunner } from "../src/acp";
import { createFakeCloseoutGate } from "../src/closeout";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker } from "../src/linear";
import { checkLinearSignature } from "../src/linear";
import { createFakeQuestionChannel } from "../src/questions";

describe("fakes", () => {
  test("tracker records calls", async () => {
    const tracker = createFakeTracker([
      {
        linearIssueId: "iss_1",
        identifier: "ENG-1",
        title: "Export",
        description: null,
        subIssues: [],
      },
    ]);
    expect((await tracker.loadEpic("iss_1")).identifier).toBe("ENG-1");
    expect(await tracker.listDeps("iss_1")).toEqual([]);
    await tracker.postProgress({ sessionId: "s", kind: "thought", body: "Starting" });
    await tracker.askQuestion({ sessionId: "s", body: "Include archived rows?" });
    await tracker.setStatus({ linearIssueId: "iss_1", stateType: "started" });
    expect(tracker.progress).toHaveLength(1);
    expect(tracker.questions).toHaveLength(1);
    expect(tracker.statuses).toHaveLength(1);
    expect(checkLinearSignature({ signature: "sig", secret: "secret" })).toEqual({
      ok: false,
      reason: "not_implemented",
    });
  });

  test("acp, closeout, github, and questions record calls", async () => {
    const acp = createFakeAcpRunner();
    const updates: string[] = [];
    const started = await acp.start({
      itemId: "item-1",
      worktree: "/tmp/wt",
      prompt: "do the thing",
      onUpdate: (update) => updates.push(update.summary),
    });
    await acp.cancel(started.sessionId);
    expect(acp.starts).toHaveLength(1);
    expect(acp.cancels).toEqual([started.sessionId]);
    expect(updates).toEqual(["fake end"]);

    const gate = createFakeCloseoutGate("rejected");
    const verdict = await gate.run({
      taskId: "ENG-1",
      worktree: "/tmp/wt",
      baseSha: "a",
      headSha: "b",
      attempt: 1,
    });
    expect(verdict.decision).toBe("rejected");
    expect(gate.runs).toHaveLength(1);

    const github = createFakeGitHub();
    const token = await github.mintInstallationToken({
      installationId: "99",
      repository: "pmdroid/paws-demo",
    });
    expect(token.token).toBe("fake-installation-token");
    const pr = await github.open({
      repository: "pmdroid/paws-demo",
      head: "paws/eng-1",
      base: "main",
      title: "Export",
      body: "Fixes ENG-1",
    });
    const merged = await github.merge({
      repository: "pmdroid/paws-demo",
      number: pr.number,
      expectedHeadSha: "abc",
    });
    expect(merged.merged).toBe(true);
    expect(github.opened).toHaveLength(1);

    const questions = createFakeQuestionChannel();
    const asked = await questions.ask({
      itemId: "item-1",
      title: "Rows",
      body: "Include archived?",
    });
    await questions.deliverAnswer({
      questionId: asked.questionId,
      answer: "no",
      answeredBy: "pascal",
    });
    expect(questions.answers[0]?.answeredBy).toBe("pascal");
  });
});
