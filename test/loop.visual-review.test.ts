import { runAgent } from "../src/acp";
import { PreviewRequestSchema, createFakePreviewRuntime, runPreview } from "../src/live-preview";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type Clock } from "../src/core";
import {
  JobLoop,
  applyWorkItemEvent,
  enqueueJobOnce,
  getLinkAsk,
  livePreviewForQuestion,
  OutboxDispatcher,
  getRun,
  getWorkItem,
  listEvidence,
  listJobs,
  listVisualReviewMarks,
  listVisualReviews,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  releaseRunCapacity,
  runnerHasCapacity,
  saveCheckpoint,
  saveCloseoutRecovery,
  syncWorkspaceMember,
} from "../src/db";
import {
  createFakeCloseoutGate,
  type CloseoutVerdict,
  type FakeCloseoutGate,
} from "../src/closeout";
import { createEvidenceStore } from "../src/evidence";
import { createFakeGitHub } from "../src/github";
import {
  createFakeTracker,
  createLinearFileTransfer,
  type AcceptedLinearEvent,
} from "../src/linear";
import {
  attachOrchestrator,
  VISUAL_REVIEW_NEEDS_LINK,
  VISUAL_REVIEW_REPLY_NOTE,
  type AgentLaunch,
} from "../src/loop";
import {
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  openQuestion,
  rejectedEvidenceIds,
  visualReviewContinueQuestion,
  VISUAL_REVIEW_ANSWERERS,
  VISUAL_REVIEW_ROUNDS,
  VISUAL_REVIEW_REMINDER_MS,
  visualReviewCarriedNote,
} from "../src/questions";
import { saveSchedulingContext } from "../src/scheduler";
import { githubClient } from "./e2e-harness";
import { screenshotPng, type Rect } from "./png";
import { workspaceAdmission } from "./fake-workspace";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const ASSET = "https://uploads.linear.app/workspace/evidence";
/** The one reminder the shared link ask posts after 24 hours. */
const REMINDED = "**Still waiting for your decision on";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function closeoutPolicy(paths?: string[]): string {
  return `specVersion: "0.1"
items:
  - id: visual-proof
    kind: evidence
    gate: beforePR
    media: [image]
    minimum: 2
    approval: human
${paths ? `    paths: ${JSON.stringify(paths)}\n` : ""}`;
}

type Step = Record<string, unknown>;

function publishTwo(worktree: string, n: number): Step[] {
  const names = [`shot-${2 * n - 1}.png`, `shot-${2 * n}.png`];
  for (const name of names)
    writeFileSync(path.join(worktree, name), Buffer.concat([PNG, Buffer.from(name)]));
  return names.map((name) => ({ type: "publish_artifact", path: name, checkId: "visual-proof" }));
}

test("show_preview on the runner becomes ready, waits for Accept, then opens the pull request", async () => {
  const f = await pausedForReview({ preview: true });
  try {
    await f.until(() => findOpenQuestion(f.db, "ses_1") !== null);
    const question = findOpenQuestion(f.db, "ses_1")!;
    expect(getLinkAsk(f.db, question.id)?.kind).toBe("preview");
    expect(f.github.opened).toHaveLength(0);
    expect(f.previewRuntime.stopped).toBe(false);
    expect(await f.approve("someone-else")).toBe("forbidden");
    await f.orchestrator.onLinearEvent(prompted("Change the app", "someone-else"));
    expect(getLinkAsk(f.db, question.id)?.closedAt).toBeNull();
    expect(f.previewRuntime.stopped).toBe(false);
    expect(f.github.opened).toHaveLength(0);
    expect(await f.approve()).toBe("answered");
    await f.turn;
    await f.driveUntil(() => f.github.opened.length === 1);
    expect(f.previewRuntime.stopped).toBe(true);
    expect(f.github.opened[0]!.title).toBe("Add the fixture screen");
    expect(f.tracker.questions).toHaveLength(1);
    expect(f.tracker.questions[0]!.body).toContain("[Review in Paws]");
    expect(f.tracker.questions[0]!.body).toContain(
      "[Open preview](https://paws-preview-1.test-tail.ts.net/)",
    );
  } finally {
    await f.close();
  }
}, 90000);

test("host abort and redelivery preserve the active preview and original deadline", async () => {
  const f = await pausedForReview({ preview: true, previewReconnect: true });
  try {
    await f.until(() => findOpenQuestion(f.db, "ses_1") !== null);
    // Wait for the simulated reconnect to redeliver after advancing its clock.
    await f.until(() =>
      Boolean(f.db.query<{ ready: string }, []>("SELECT ready FROM live_preview").get()),
    );
    await Bun.sleep(100);
    expect(await f.approve()).toBe("answered");
    await f.turn;
    await f.driveUntil(() => f.github.opened.length === 1);
    expect(f.tracker.questions).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 90000);

test("loss of the preview execution rejects Accept immediately", async () => {
  const f = await pausedForReview({ preview: true });
  try {
    await f.until(() => findOpenQuestion(f.db, "ses_1") !== null);
    f.losePreviewRunner();
    expect(await f.approve()).toBe("rejected");
    expect(livePreviewForQuestion(f.db, findOpenQuestion(f.db, "ses_1")!.id)).toBeNull();
    expect(f.github.opened).toHaveLength(0);
    await f.turn;
  } finally {
    await f.close();
  }
}, 90000);

test.each(["offline", "revoked", "other-owner"] as const)(
  "an %s runner cannot satisfy preview capability",
  async (previewIneligible) => {
    const f = await pausedForReview({ preview: true, previewUnavailable: true, previewIneligible });
    try {
      await f.turn;
      await f.until(() => f.tracker.questions.length > 0);
      expect(f.tracker.questions[0]!.body).toContain("Upgrade the runner");
      expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(0);
      expect(f.github.opened).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  90000,
);

test("a required preview restarts after verification without a runner row on the current run", async () => {
  const f = await pausedForReview({ preview: true, previewDeferred: true });
  try {
    await f.turn;
    expect(f.tracker.questions).toHaveLength(0);
    expect(
      listJobs(f.db).some(
        (job) => job.queue === JOB_KIND.resume && job.jobKey?.startsWith("preview-required:"),
      ),
    ).toBe(true);
    const currentRunId = listWorkItems(f.db)[0]!.currentRunId;
    expect(f.db.query("SELECT 1 FROM runner_work WHERE run_id=?").get(currentRunId!)).toBeNull();
  } finally {
    await f.close();
  }
}, 90000);

test("a runner without show_preview asks for an upgrade without spending a fix round", async () => {
  const f = await pausedForReview({ preview: true, previewUnavailable: true });
  try {
    await f.turn;
    await f.until(() => f.tracker.questions.length > 0);
    expect(f.github.opened).toHaveLength(0);
    expect(f.tracker.questions[0]!.body).toContain("Upgrade the runner");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(0);
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
  } finally {
    await f.close();
  }
}, 90000);

test("a local execution asks for a preview-capable runner without a fix round", async () => {
  const f = await pausedForReview({
    preview: true,
    previewLocal: true,
    implement: (worktree) => {
      writeFileSync(path.join(worktree, "README.md"), "Local candidate\n");
      return [];
    },
  });
  try {
    await f.turn;
    await f.until(() => f.tracker.questions.length > 0);
    expect(f.github.opened).toHaveLength(0);
    expect(f.tracker.questions[0]!.body).toContain("Upgrade the runner");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 90000);

test("two screenshots published 10 s apart end the turn with one link ask that names both", async () => {
  const f = await pausedForReview();
  try {
    const item = listWorkItems(f.db)[0]!;
    expect(item.state).toBe("awaiting_input");
    expect(item.checkpoint?.phase).toBe("awaiting_input");
    expect(getRun(f.db, item.currentRunId!)?.status).toBe("ended");
    expect(runnerHasCapacity(f.db, f.runnerId, Date.now())).toBe(true);
    const [first, second] = listEvidence(f.db, item.id);
    expect(second!.createdAt - first!.createdAt).toBeGreaterThanOrEqual(10_000);
    expect(f.lastPublication()).toMatch(
      /^\[shot-2\.png\]\(<https:\/\/paws\.example\/evidence\/[^>]+>\)$/,
    );

    const open = findOpenQuestion(f.db, "ses_1")!;
    expect(open.kind).toBe("link");
    expect(getLinkAsk(f.db, open.id)).toMatchObject({
      kind: "screenshots",
      headCommit: item.checkpoint?.wipCommit,
    });
    expect(f.tracker.questions).toHaveLength(1);
    const [question] = f.tracker.questions;
    // No answer buttons: the screens are approved on the item page, where they are in view.
    expect(question!.options ?? []).toEqual([]);
    expect(question!.body).toContain("2 changed screens for visual-proof: shot-1.png, shot-2.png.");
    expect(question!.body).toContain(
      "Decide in Paws: https://paws.example/status/issues/ENG-7#visual-review",
    );
    expect(question!.body).toContain("A reply here cannot approve the screens.");
    expect(f.log.filter((entry) => entry.kind === "elicitation")).toHaveLength(1);

    const posted = f.log.length;
    for (const step of [60_000, 60 * 60_000, VISUAL_REVIEW_REMINDER_MS - 62 * 60_000]) {
      f.advance(step);
      await f.tickAll();
    }
    expect(f.log).toHaveLength(posted);
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
  } finally {
    await f.close();
  }
}, 90_000);

test("a Paws without an https dashboard link leaves the check unapproved and asks nothing in Linear", async () => {
  const f = await pausedForReview({ publicUrl: "http://127.0.0.1:8787" });
  try {
    await f.until(() => f.notes(VISUAL_REVIEW_NEEDS_LINK) === 1);
    // Nothing in Linear can approve the screens: Closeout stays blocked on the check.
    expect(listVisualReviews(f.db, listWorkItems(f.db)[0]!.id)).toEqual([]);
    expect(f.tracker.questions.every((question) => !question.options?.length)).toBe(true);
    expect(f.tracker.questions.map((question) => question.body.split("\n")[0])).toEqual([
      "Closeout needs your help.",
    ]);
    await f.orchestrator.onLinearEvent(prompted("Accept", "delegator-1"));
    expect(listVisualReviews(f.db, listWorkItems(f.db)[0]!.id)).toEqual([]);
    expect(f.github.opened).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 90_000);

test("a reply from someone who can't answer gets a note; the delegator's reply requests changes", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent(prompted("Accept", "someone-else"));
    expect(getQuestion(f.db, open.id)?.status).toBe("open");
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(0);
    expect(f.notes(VISUAL_REVIEW_ANSWERERS)).toBe(1);

    await f.orchestrator.onLinearEvent(prompted("Looks good", "delegator-1", "activity:ok"));
    expect(getQuestion(f.db, open.id)).toMatchObject({
      status: "answered",
      answeredBy: "delegator-1",
    });
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "changes_requested",
      feedback: "Looks good",
    });
    expect(f.notes(VISUAL_REVIEW_ANSWERERS)).toBe(1);
  } finally {
    await f.close();
  }
}, 90_000);

test("the project lead can approve on the page and nobody else can", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    expect(await f.approve("someone-else")).toBe("forbidden");
    expect(getVisualReview(f.db, open.id)?.outcome).toBeNull();
    expect(await f.approve("lead-1")).toBe("answered");
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "accepted",
      answeredBy: "lead-1",
    });
  } finally {
    await f.close();
  }
}, 90_000);

test("the reminder is posted once after 24 hours, without buttons", async () => {
  const f = await pausedForReview();
  try {
    await f.tickAll();
    expect(f.reminders()).toBe(0);

    f.advance(VISUAL_REVIEW_REMINDER_MS - 60_000);
    await f.tickAll();
    expect(f.reminders()).toBe(0);

    f.advance(60_000);
    await f.tickAll();
    expect(f.reminders()).toBe(1);

    f.advance(VISUAL_REVIEW_REMINDER_MS * 3);
    await f.tickAll();
    expect(f.reminders()).toBe(1);
    const last = f.log.at(-1)!;
    expect(last.kind).toBe("elicitation");
    expect(last.body).toContain(
      "Decide in Paws: https://paws.example/status/issues/ENG-7#visual-review",
    );
    expect(last).not.toHaveProperty("options");
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")).not.toBeNull();
  } finally {
    await f.close();
  }
}, 90_000);

test("stopping the task ends the wait", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent({
      ...prompted("", "delegator-1"),
      body: null,
      signal: "stop",
    });
    expect(listWorkItems(f.db)[0]!.state).toBe("cancelled");
    expect(getQuestion(f.db, open.id)?.status).toBe("cancelled");

    f.advance(VISUAL_REVIEW_REMINDER_MS);
    await f.tickAll();
    expect(f.reminders()).toBe(0);
    expect(await f.approve("delegator-1", open.id)).toBe("rejected");
    expect(getVisualReview(f.db, open.id)?.outcome).toBeNull();
  } finally {
    await f.close();
  }
}, 90_000);

test("Approve on the page records the approval, passes the check and opens the pull request", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    const wip = item.checkpoint?.wipCommit;
    expect(wip).toMatch(/^[0-9a-f]{40}$/);
    putWorkspaceUser(f.db, {
      id: "user-ada",
      linearUserId: "delegator-1",
      name: "Ada Reviewer",
      email: "ada@example.invalid",
    });

    expect(await f.approve()).toBe("answered");
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "accepted",
      answeredBy: "delegator-1",
      headCommit: wip,
      evidenceIds: listEvidence(f.db, item.id).map((row) => row.id),
    });
    expect(getVisualReview(f.db, open.id)?.answeredAt).toBeNumber();

    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.github.opened).toHaveLength(1);
    const body = f.github.opened[0]!.body;
    expect(body).toContain(
      `Visual review accepted by Ada Reviewer in Paws for ${wip!.slice(0, 7)}.`,
    );
    expect(body).toContain(`![shot-1.png](<${ASSET}>)`);
    expect(body).toContain(`![shot-2.png](<${ASSET}>)`);
    // Approve completes the evaluation of the reviewed head: no agent turn.
    expect(f.prompts).toHaveLength(1);
    expect(f.tracker.questions).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)?.state).not.toBe("awaiting_input");
  } finally {
    await f.close();
  }
}, 120_000);

test("Accept replied in Linear requests changes and never approves", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent(prompted("Accept", "delegator-1"));
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "changes_requested",
      feedback: "Accept",
    });
    expect(getLinkAsk(f.db, open.id)?.closedReason).toBe("guidance");
    await f.until(() => f.notes(VISUAL_REVIEW_REPLY_NOTE) === 1);
    expect(f.github.opened).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 90_000);

test("a reply in Linear requests changes, and new screenshots ask again", async () => {
  const f = await pausedForReview();
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;

    await f.orchestrator.onLinearEvent(
      prompted("Make the hint under Model shorter", "delegator-1", "activity:changes"),
    );
    expect(getVisualReview(f.db, first.id)).toMatchObject({
      outcome: "changes_requested",
      feedback: "Make the hint under Model shorter",
    });
    const before = listEvidence(f.db, item.id).map((row) => row.id);
    expect([...rejectedEvidenceIds(f.db, item.id)].sort()).toEqual(before.sort());

    await f.driveUntil(() => f.tracker.questions.length === 2);
    expect(f.prompts[1]).toContain("Make the hint under Model shorter");
    expect(f.prompts[1]).toContain('checkId "visual-proof"');
    const second = f.tracker.questions[1]!;
    expect(second.body).toContain("shot-3.png");
    expect(second.body).toContain("shot-4.png");
    expect(second.body).not.toContain("shot-1.png");
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    const rejected = rejectedEvidenceIds(f.db, item.id);
    expect(
      listEvidence(f.db, item.id)
        .filter((row) => !rejected.has(row.id))
        .map((row) => row.displayName),
    ).toEqual(["shot-3.png", "shot-4.png"]);
  } finally {
    await f.close();
  }
}, 120_000);

test("Request changes from the run page hands the marked screenshot and note to the agent", async () => {
  let worktree = "";
  const f = await pausedForReview({
    implement(dir, n, prompt) {
      worktree = dir;
      return n === 1 || prompt.includes('publish_artifact and checkId "visual-proof"')
        ? publishTwo(dir, n)
        : [];
    },
  });
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    const shot = listEvidence(f.db, item.id)[1]!;
    const marked = Buffer.concat([PNG, Buffer.from("red circle")]);
    const mark = {
      id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      questionId: open.id,
      evidenceId: shot.id,
      sizeBytes: marked.byteLength,
      sha256: createHash("sha256").update(marked).digest("hex"),
      createdAt: Date.now(),
    };
    writeFileSync(path.join(f.evidenceRoot, mark.id), marked);
    const request = { questionId: open.id, note: "Move the save button left", marks: [mark] };

    expect(
      await f.orchestrator.requestVisualReviewChanges({
        ...request,
        answeredBy: "someone-else",
        actor: f.actor("someone-else"),
      }),
    ).toBe("forbidden");
    expect(getQuestion(f.db, open.id)?.status).toBe("open");
    expect(listVisualReviewMarks(f.db, open.id)).toEqual([]);

    expect(
      await f.orchestrator.requestVisualReviewChanges({
        ...request,
        answeredBy: "delegator-1",
        actor: f.actor("delegator-1"),
      }),
    ).toBe("answered");
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "changes_requested",
      answeredBy: "delegator-1",
      feedback: "Move the save button left",
    });
    expect(listVisualReviewMarks(f.db, open.id)).toEqual([mark]);
    expect(
      await f.orchestrator.requestVisualReviewChanges({
        ...request,
        answeredBy: "delegator-1",
        actor: f.actor("delegator-1"),
      }),
    ).toBe("rejected");

    await f.driveUntil(() => f.tracker.questions.length === 2);
    expect(f.prompts[1]).toContain("Move the save button left");
    expect(f.prompts[1]).toContain(
      `- ./.paws-visual-review/${mark.id}.png: shot-2.png (evidence ${shot.id}, published at commit ${shot.headCommit.slice(0, 7)})`,
    );
    const text = f
      .received(1)
      .map((block) => block.text ?? "")
      .join("\n");
    const local = new RegExp(`\\./\\.paws-visual-review/[0-9a-f]{64}/${mark.id}\\.png`).exec(
      text,
    )?.[0];
    expect(local).toBeString();
    expect(text).toContain(`Input file: ${local} (image/png)`);
    expect(readFileSync(path.join(worktree, local!))).toEqual(marked);
    const ignored = await exec("git", ["-C", worktree, "check-ignore", local!]);
    expect(ignored.stdout.trim()).toBe(local!);
    expect(readFileSync(path.join(f.evidenceRoot, shot.id))).toEqual(
      Buffer.concat([PNG, Buffer.from("shot-2.png")]),
    );
  } finally {
    await f.close();
  }
}, 120_000);

test("after three rounds of changes Paws asks whether to keep going instead of resuming", async () => {
  const f = await pausedForReview();
  try {
    for (let round = 1; round <= VISUAL_REVIEW_ROUNDS; round++) {
      await f.orchestrator.onLinearEvent(
        prompted(`Change ${round}`, "delegator-1", `activity:change-${round}`),
      );
      if (round < VISUAL_REVIEW_ROUNDS)
        await f.driveUntil(() => f.tracker.questions.length === round + 1);
    }
    await f.tickAll();
    expect(f.prompts).toHaveLength(VISUAL_REVIEW_ROUNDS);
    expect(f.tracker.questions).toHaveLength(VISUAL_REVIEW_ROUNDS + 1);
    const asked = f.tracker.questions.at(-1)!;
    expect(asked.body).toContain(visualReviewContinueQuestion(VISUAL_REVIEW_ROUNDS));
    expect(asked.options).toEqual(["Keep going"]);
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(
      listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume && job.finishedAt === null),
    ).toEqual([]);

    await f.orchestrator.onLinearEvent(
      prompted("Keep going", "delegator-1", "activity:keep-going"),
    );
    await f.driveUntil(() => f.tracker.questions.length === VISUAL_REVIEW_ROUNDS + 2);
    expect(f.prompts).toHaveLength(VISUAL_REVIEW_ROUNDS + 1);
    expect(f.prompts.at(-1)).toContain(`Change ${VISUAL_REVIEW_ROUNDS}`);
    expect(f.tracker.questions.at(-1)!.body).toContain("Decide in Paws:");
  } finally {
    await f.close();
  }
}, 180_000);

test("a change under the check's paths after acceptance asks again", async () => {
  const f = await pausedForReview({
    paths: ["web/**"],
    implement(worktree, n) {
      if (n <= 2) {
        mkdirSync(path.join(worktree, "web"), { recursive: true });
        writeFileSync(path.join(worktree, "web", "settings.html"), `<p>version ${n}</p>\n`);
      }
      if (n === 1) return publishTwo(worktree, 1);
      return n === 3 ? publishTwo(worktree, 2) : [];
    },
  });
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    expect(await f.approve()).toBe("answered");
    await f.orchestrator.onLinearEvent(followUp());
    await f.driveUntil(() => f.tracker.questions.length === 2);

    expect(getVisualReview(f.db, first.id)?.outcome).toBe("stale");
    expect(f.github.opened).toHaveLength(0);
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[2]).toContain("changed after its visual review was accepted");
    expect(f.tracker.questions[1]!.body).toContain("shot-3.png");
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");

    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.github.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 180_000);

test("a review accepted for some of the files asks again about the rest instead of blocking Closeout", async () => {
  const f = await pausedForReview();
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    coverOnlyFirstShot(f.db, item.id, first.id);

    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => f.tracker.questions.length === 2);

    expectReviewOfSecondShot(f.tracker.questions[1]!);
    expect(f.log.at(-1)?.kind).toBe("elicitation");
    expect(getVisualReview(f.db, first.id)?.outcome).toBe("accepted");
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(f.github.opened).toHaveLength(0);

    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.tracker.questions).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 120_000);

test("retry on a task Closeout blocked for an uncovered file asks a new review round about it", async () => {
  const f = await pausedForReview();
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    coverOnlyFirstShot(f.db, item.id, first.id);
    expect(await f.approve()).toBe("answered");
    f.db.run("DELETE FROM job WHERE queue = ? AND finished_at IS NULL", [JOB_KIND.resume]);
    const blocked = openQuestion(f.db, {
      itemId: item.id,
      sessionId: "ses_1",
      body: "Closeout needs your help.",
      now: Date.now(),
    });
    saveCloseoutRecovery(f.db, {
      questionId: blocked.id,
      taskId: item.id,
      itemId: item.id,
      base: item.checkpoint!.baseSha!,
      head: item.checkpoint!.wipCommit!,
      policyDigest: "",
      failedChecks: [],
      retryBaseline: [],
      summary: "Closeout: blocked\nvisual-proof: missing",
    });
    applyWorkItemEvent(f.db, item.id, "blocking_question");

    await f.orchestrator.onLinearEvent(prompted("retry", "delegator-1", "activity:retry"));
    await f.driveUntil(() => f.tracker.questions.length === 2);

    expectReviewOfSecondShot(f.tracker.questions[1]!);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(f.github.opened).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 120_000);

test("an accepted review at an unchanged head stays accepted when the checkpoint names another commit", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    const head = item.checkpoint!.wipCommit!;
    const base = item.checkpoint!.baseSha!;
    expect(head).not.toBe(base);
    saveCheckpoint(f.db, item.id, { phase: "awaiting_input", baseSha: base, wipCommit: base });

    expect(await f.approve()).toBe("answered");
    expect(getVisualReview(f.db, open.id)?.headCommit).toBe(head);

    await f.driveUntil(() => f.github.opened.length > 0 || f.tracker.questions.length > 1);
    expect(getVisualReview(f.db, open.id)?.outcome).toBe("accepted");
    expect(f.tracker.questions).toHaveLength(1);
    expect(f.github.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 120_000);

const SCREENS = [
  "Runner card with three sessions desktop.png",
  "Runner card with three sessions 390.png",
  "Idle runner card desktop.png",
  "Idle runner card 390.png",
];

function publishScreensThreeTimes(worktree: string): Step[] {
  return [1, 2, 3].flatMap((copy) =>
    SCREENS.map((displayName, index) => {
      const file = `screen-${index}-${copy}.png`;
      writeFileSync(path.join(worktree, file), Buffer.concat([PNG, Buffer.from(file)]));
      return { type: "publish_artifact", path: file, displayName, checkId: "visual-proof" };
    }),
  );
}

test("4 screens published 3 times ask one review of the 4 latest files, and Accept passes visual-proof", async () => {
  const f = await pausedForReview({
    implement: (worktree, n) => (n === 1 ? publishScreensThreeTimes(worktree) : []),
  });
  try {
    const item = listWorkItems(f.db)[0]!;
    const rows = listEvidence(f.db, item.id);
    expect(rows).toHaveLength(12);
    const latest = rows.slice(8).map((row) => row.id);
    const open = findOpenQuestion(f.db, "ses_1")!;
    expect(getVisualReview(f.db, open.id)?.evidenceIds).toEqual(latest);
    const [question] = f.tracker.questions;
    expect(question!.body).toContain(`4 changed screens for visual-proof: ${SCREENS.join(", ")}.`);

    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => f.github.opened.length > 0 || f.tracker.questions.length > 1);
    expect(f.tracker.questions).toHaveLength(1);
    expect(f.github.opened).toHaveLength(1);
    expect(f.github.opened[0]!.body.match(/!\[/g)).toHaveLength(4);
  } finally {
    await f.close();
  }
}, 120_000);

const DESKTOP: Rect[] = [
  { x: 20, y: 20, width: 300, height: 40, rgb: 0x111111 },
  { x: 20, y: 100, width: 200, height: 120, rgb: 0xff7a3d },
];
const NARROW: Rect[] = [
  { x: 10, y: 20, width: 150, height: 40, rgb: 0x111111 },
  { x: 10, y: 100, width: 120, height: 160, rgb: 0xff7a3d },
];

/** Publishes PNG screens under their display names at turn `n`. */
function publishScreens(worktree: string, n: number, screens: Record<string, Buffer>): Step[] {
  return Object.entries(screens).map(([displayName, png], index) => {
    const file = `screen-${n}-${index}.png`;
    writeFileSync(path.join(worktree, file), png);
    return { type: "publish_artifact", path: file, displayName, checkId: "visual-proof" };
  });
}

/**
 * Turn 1 publishes the first screens and waits for Accept. A follow-up starts
 * turn 2, which changes web/settings.html, so the review goes stale, and
 * turn 3 publishes `again`.
 */
async function republishedAfterAcceptance(again: Record<string, Buffer>) {
  const f = await pausedForReview({
    paths: ["web/**"],
    implement(worktree, n) {
      if (n <= 2) {
        mkdirSync(path.join(worktree, "web"), { recursive: true });
        writeFileSync(path.join(worktree, "web", "settings.html"), `<p>version ${n}</p>\n`);
      }
      if (n === 1)
        return publishScreens(worktree, n, {
          "Settings desktop": screenshotPng(400, 300, DESKTOP),
          "Settings 390": screenshotPng(200, 300, NARROW),
        });
      return n === 3 ? publishScreens(worktree, n, again) : [];
    },
  });
  putWorkspaceUser(f.db, {
    id: "user-ada",
    linearUserId: "delegator-1",
    name: "Ada Reviewer",
    email: "ada@example.invalid",
  });
  const first = findOpenQuestion(f.db, "ses_1")!;
  expect(await f.approve()).toBe("answered");
  await f.orchestrator.onLinearEvent(followUp());
  await f.driveUntil(
    () => f.prompts.length === 3 && f.github.opened.length + f.tracker.questions.length > 1,
  );
  expect(getVisualReview(f.db, first.id)?.outcome).toBe("stale");
  return { f, first };
}

test("republished screenshots with identical bytes pass visual-proof with no question", async () => {
  const { f, first } = await republishedAfterAcceptance({
    "Settings desktop": screenshotPng(400, 300, DESKTOP),
    "Settings 390": screenshotPng(200, 300, NARROW),
  });
  try {
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.tracker.questions).toHaveLength(1);
    const item = listWorkItems(f.db)[0]!;
    const republished = listEvidence(f.db, item.id).slice(2);
    const carried = f.db
      .query<{ question_id: string }, [string]>(
        "SELECT question_id FROM visual_review WHERE item_id = ? AND question_id LIKE 'carry_%'",
      )
      .all(item.id);
    expect(carried).toHaveLength(1);
    const review = getVisualReview(f.db, carried[0]!.question_id)!;
    expect(review).toMatchObject({
      outcome: "accepted",
      answeredBy: "delegator-1",
      evidenceIds: republished.map((row) => row.id),
    });
    const approvedAt = getVisualReview(f.db, first.id)!.answeredAt!;
    expect(review.carried).toEqual(
      republished.map((row, index) => ({
        evidenceId: row.id,
        fromEvidenceId: listEvidence(f.db, item.id)[index]!.id,
        approvalId: first.id,
        approvedBy: "delegator-1",
        approvedAt,
        match: "identical",
      })),
    );
    const line = visualReviewCarriedNote(approvedAt, review.answeredAt!);
    expect(line).toMatch(
      /^Visual review carried over: unchanged since your approval at \d\d:\d\d UTC\.$/,
    );
    expect(f.notes(line)).toBe(1);
    const body = f.github.opened[0]!.body;
    expect(body).toContain(`Visual review carried over from the approval by Ada Reviewer at `);
    expect(body).toContain(
      `(approval ${first.id}), unchanged since: Settings desktop, Settings 390.`,
    );
  } finally {
    await f.close();
  }
}, 180_000);

test("a screen within tolerance carries over, and a visibly changed one is asked", async () => {
  const { f, first } = await republishedAfterAcceptance({
    // A clock in the corner moved: 80 of 120,000 pixels.
    "Settings desktop": screenshotPng(400, 300, [
      ...DESKTOP,
      { x: 350, y: 280, width: 10, height: 8, rgb: 0x333333 },
    ]),
    // The button moved.
    "Settings 390": screenshotPng(200, 300, [
      NARROW[0]!,
      { x: 60, y: 100, width: 120, height: 160, rgb: 0xff7a3d },
    ]),
  });
  try {
    expect(f.tracker.questions).toHaveLength(2);
    const question = f.tracker.questions[1]!;
    expect(question.body).toContain(
      "1 changed screen for visual-proof: Settings 390. Unchanged since your approval, so not asked again: Settings desktop.",
    );
    const item = listWorkItems(f.db)[0]!;
    const [desktop, narrow] = listEvidence(f.db, item.id).slice(2);
    const open = findOpenQuestion(f.db, "ses_1")!;
    const review = getVisualReview(f.db, open.id)!;
    expect(review.evidenceIds).toEqual([desktop!.id, narrow!.id]);
    expect(review.carried).toEqual([
      {
        evidenceId: desktop!.id,
        fromEvidenceId: listEvidence(f.db, item.id)[0]!.id,
        approvalId: first.id,
        approvedBy: "delegator-1",
        approvedAt: getVisualReview(f.db, first.id)!.answeredAt!,
        match: "similar",
      },
    ]);

    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.tracker.questions).toHaveLength(2);
    const body = f.github.opened[0]!.body;
    expect(body).toContain("Visual review accepted by Ada Reviewer");
    expect(body).toContain(`Carried over from the approval by Ada Reviewer at `);
    expect(body).toContain("unchanged since: Settings desktop.");
  } finally {
    await f.close();
  }
}, 180_000);

test("a screen with a new name is always asked", async () => {
  const { f } = await republishedAfterAcceptance({
    "Settings desktop": screenshotPng(400, 300, DESKTOP),
    "Settings dark": screenshotPng(200, 300, NARROW),
  });
  try {
    expect(f.tracker.questions).toHaveLength(2);
    const question = f.tracker.questions[1]!;
    expect(question.body).toContain(
      "1 changed screen for visual-proof: Settings dark. Unchanged since your approval, so not asked again: Settings desktop.",
    );
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(f.github.opened).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 180_000);

/** Commands and the independent review passed on `head`; only the human check is open. */
function pendingHuman(head: string): CloseoutVerdict {
  const items = [
    { id: "test", kind: "command", state: "passed" as const, message: "" },
    { id: "independent-review", kind: "review", state: "passed" as const, message: "" },
    { id: "visual-proof", kind: "evidence", state: "missing" as const, message: "approval" },
  ];
  const summary = "Closeout: blocked\nvisual-proof: missing";
  return {
    decision: "blocked",
    exhausted: false,
    summary,
    result: {
      outcome: "blocked",
      taskId: "ENG-7",
      base: "",
      head,
      fixAttempts: 0,
      evaluations: 1,
      exitCode: 3,
      summary,
      decision: {
        specVersion: "0.1",
        decision: "blocked",
        gate: "beforePR",
        base: "",
        head,
        candidate: { session: "s", model: "m", provider: "p" },
        policy: { path: null, digest: null, absent: false },
        items,
        warnings: [],
      },
    },
  };
}

const ACCEPTED: CloseoutVerdict = { decision: "accepted", exhausted: false, summary: "accepted" };

/** A gate that holds its run open: the commands and the review are still running. */
function heldGate() {
  const gate = createFakeCloseoutGate();
  let release!: () => void;
  gate.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
}

test("the visual review waits beside the commands and the independent review of the same head", async () => {
  const { gate, release } = heldGate();
  const f = await pausedForReview({ gate });
  try {
    await f.until(() => f.tracker.questions.length === 1 && gate.runs.length === 1);
    const item = listWorkItems(f.db)[0]!;
    // Both are in flight: the question is open while Closeout runs on the same head.
    expect(item.state).toBe("verifying");
    const open = findOpenQuestion(f.db, "ses_1")!;
    expect(open.kind).toBe("link");
    expect(getVisualReview(f.db, open.id)?.headCommit).toBe(gate.runs[0]!.headSha);

    gate.next = pendingHuman(gate.runs[0]!.headSha);
    release();
    await f.turn;
    await f.tickAll();
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.id).toBe(open.id);
    expect(runnerHasCapacity(f.db, f.runnerId, Date.now())).toBe(true);

    // The gate reads approvals: once the person accepts, later runs pass the check.
    gate.decided = ACCEPTED;
    gate.next = ACCEPTED;
    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => gate.decisions.length > 0);
    // Accept completed the evaluation from the finished checks: no second run, no agent turn.
    expect(gate.runs).toHaveLength(1);
    expect(gate.decisions.map((entry) => entry.headSha)).toEqual([gate.runs[0]!.headSha]);
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.prompts).toHaveLength(1);
    expect(f.tracker.questions).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 120_000);

test("Accept while the commands still run passes the check, and the evaluation completes when they do", async () => {
  const { gate, release } = heldGate();
  const f = await pausedForReview({ gate });
  try {
    await f.until(() => f.tracker.questions.length === 1 && gate.runs.length === 1);
    expect(await f.approve()).toBe("answered");
    const item = listWorkItems(f.db)[0]!;
    expect(item.state).toBe("verifying");
    expect(gate.decisions).toHaveLength(0);

    gate.next = pendingHuman(gate.runs[0]!.headSha);
    gate.decided = ACCEPTED;
    release();
    await f.turn;
    await f.driveUntil(() => gate.decisions.length > 0);
    // The gate reads approvals: later runs, such as the merge lane's, pass the check.
    gate.next = ACCEPTED;
    expect(gate.runs).toHaveLength(1);
    expect(gate.decisions).toHaveLength(1);
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.tracker.questions).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 120_000);

test("Request changes while the commands still run restarts the item for review", async () => {
  const { gate, release } = heldGate();
  const f = await pausedForReview({ gate });
  try {
    await f.until(() => f.tracker.questions.length === 1 && gate.runs.length === 1);
    gate.next = ACCEPTED;
    await f.orchestrator.onLinearEvent(
      prompted("Make the hint under Model shorter", "delegator-1", "activity:changes"),
    );
    const item = listWorkItems(f.db)[0]!;
    expect(item.state).toBe("queued");
    expect(
      f.db
        .query<{ reason: string }, [string]>(
          "SELECT reason FROM work_item_event WHERE item_id = ? AND kind = 'restart'",
        )
        .all(item.id),
    ).toEqual([{ reason: "review" }]);
    release();
    await f.turn;
    // The accepted verdict of the replaced head does not reach the merge queue.
    expect(getWorkItem(f.db, item.id)?.state).not.toBe("merge_queue");
    expect(f.github.opened).toHaveLength(0);
    gate.next = pendingHuman("");
    // The runner settles the stopped work, and the scheduler places the restarted item.
    releaseRunCapacity(f.db, getWorkItem(f.db, item.id)!.currentRunId!, Date.now());
    f.orchestrator.reconcileExecution();
    await f.driveUntil(() => f.prompts.length === 2);
    expect(f.prompts[1]).toContain("Make the hint under Model shorter");
  } finally {
    await f.close();
  }
}, 120_000);

/** Moves main forward and rebases the task's worktree onto it, as the merge lane does. */
async function rebaseOntoNewMain(f: { bare: string; root: string }, worktree: string) {
  const other = path.join(f.root, `main-${Date.now()}`);
  await exec("git", ["clone", f.bare, other]);
  await writeFile(path.join(other, "CHANGELOG.md"), "main moved\n");
  await exec("git", ["-C", other, "add", "."]);
  await exec("git", [...IDENTITY, "-C", other, "commit", "-m", "main moved"]);
  await exec("git", ["-C", other, "push", "origin", "HEAD:main"]);
  await exec("git", ["-C", worktree, "fetch", "origin", "main"]);
  await exec("git", [...IDENTITY, "-C", worktree, "rebase", "origin/main"]);
}

const IDENTITY = [
  "-c",
  "user.name=Paws Test",
  "-c",
  "user.email=paws-test@example.com",
  "-c",
  "commit.gpgsign=false",
];

async function headOf(worktree: string): Promise<string> {
  return (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
}

/** The item verifies its current head again, as after a rebase in the lane. */
function reverifyNow(db: Database, itemId: string, key: string): void {
  applyWorkItemEvent(db, itemId, "answer_received");
  applyWorkItemEvent(db, itemId, "turn_ended");
  enqueueJobOnce(db, {
    queue: JOB_KIND.reverify,
    jobKey: key,
    payload: { itemId },
    now: Date.now(),
  });
}

test("a rebase that keeps the patch-id keeps the pending visual review open for the new head", async () => {
  let worktree = "";
  const gate = createFakeCloseoutGate();
  gate.next = pendingHuman("");
  const f = await pausedForReview({
    gate,
    implement(dir, n) {
      worktree = dir;
      return n === 1 ? publishTwo(dir, 1) : [];
    },
  });
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    const reviewed = getVisualReview(f.db, open.id)!.headCommit!;
    expect(item.state).toBe("awaiting_input");

    await rebaseOntoNewMain(f, worktree);
    const rebased = await headOf(worktree);
    expect(rebased).not.toBe(reviewed);
    reverifyNow(f.db, item.id, "rebased");
    await f.tickAll();

    expect(gate.runs.map((entry) => entry.headSha).at(-1)).toBe(rebased);
    expect(f.tracker.questions).toHaveLength(1);
    expect(findOpenQuestion(f.db, "ses_1")?.id).toBe(open.id);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");

    // The gate reads approvals: once the person accepts, later runs pass the check.
    gate.decided = ACCEPTED;
    gate.next = ACCEPTED;
    expect(await f.approve()).toBe("answered");
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "accepted",
      headCommit: reviewed,
    });
    expect(gate.decisions.map((entry) => entry.headSha)).toEqual([rebased]);
    expect(f.tracker.questions).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 120_000);

test("a rebase that keeps the patch-id carries an accepted visual review to the new head", async () => {
  let worktree = "";
  const gate = createFakeCloseoutGate();
  gate.next = pendingHuman("");
  const f = await pausedForReview({
    gate,
    implement(dir, n) {
      worktree = dir;
      return n === 1 ? publishTwo(dir, 1) : [];
    },
  });
  try {
    const item = listWorkItems(f.db)[0]!;
    // Accepted while Closeout still ran on the reviewed head; the head then moves.
    const open = findOpenQuestion(f.db, "ses_1")!;
    applyWorkItemEvent(f.db, item.id, "answer_received");
    applyWorkItemEvent(f.db, item.id, "turn_ended");
    expect(await f.approve()).toBe("answered");
    expect(getVisualReview(f.db, open.id)?.outcome).toBe("accepted");
    await rebaseOntoNewMain(f, worktree);
    const rebased = await headOf(worktree);
    gate.decided = ACCEPTED;
    enqueueJobOnce(f.db, {
      queue: JOB_KIND.reverify,
      jobKey: "rebased",
      payload: { itemId: item.id },
      now: Date.now(),
    });
    await f.driveUntil(() => gate.decisions.length > 0);
    // The gate reads approvals: later runs, such as the merge lane's, pass the check.
    gate.next = ACCEPTED;
    await f.driveUntil(() => f.github.opened.length > 0);

    expect(f.tracker.questions).toHaveLength(1);
    expect(gate.runs.at(-1)?.headSha).toBe(rebased);
    expect(gate.decisions.map((entry) => entry.headSha)).toEqual([rebased]);
  } finally {
    await f.close();
  }
}, 120_000);

test("a new head with a different patch-id cancels the pending visual review and asks again", async () => {
  let worktree = "";
  const gate = createFakeCloseoutGate();
  gate.next = pendingHuman("");
  const f = await pausedForReview({
    gate,
    implement(dir, n) {
      worktree = dir;
      return n === 1 ? publishTwo(dir, 1) : [];
    },
  });
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    await writeFile(path.join(worktree, "settings.html"), "<p>new layout</p>\n");
    await exec("git", ["-C", worktree, "add", "."]);
    await exec("git", [...IDENTITY, "-C", worktree, "commit", "-m", "New layout"]);
    const changed = await headOf(worktree);
    reverifyNow(f.db, item.id, "changed");
    await f.tickAll();

    expect(getQuestion(f.db, first.id)?.status).toBe("cancelled");
    expect(f.tracker.questions).toHaveLength(2);
    const second = findOpenQuestion(f.db, "ses_1")!;
    expect(second.id).not.toBe(first.id);
    expect(getVisualReview(f.db, second.id)?.headCommit).toBe(changed);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
  } finally {
    await f.close();
  }
}, 120_000);

function coverOnlyFirstShot(db: Database, itemId: string, questionId: string): void {
  const [shot] = listEvidence(db, itemId);
  db.run("UPDATE visual_review SET evidence_ids = ? WHERE question_id = ?", [
    JSON.stringify([shot!.id]),
    questionId,
  ]);
}

/** shot-1.png carries its acceptance over; only shot-2.png is asked. */
function expectReviewOfSecondShot(question: { body: string; options?: readonly unknown[] }): void {
  expect(question.options ?? []).toEqual([]);
  expect(question.body).toContain(
    "1 changed screen for visual-proof: shot-2.png. Unchanged since your approval, so not asked again: shot-1.png.",
  );
}

async function pausedForReview(
  options: {
    paths?: string[];
    preview?: boolean;
    previewUnavailable?: boolean;
    previewIneligible?: "offline" | "revoked" | "other-owner";
    previewReconnect?: boolean;
    previewDeferred?: boolean;
    previewLocal?: boolean;
    implement?: (worktree: string, n: number, prompt: string) => Step[];
    /** The Closeout fake in place of the real gate. A held run returns before the turn ends. */
    gate?: FakeCloseoutGate;
    /** The dashboard link the link ask points at. A localhost Paws cannot ask. */
    publicUrl?: string;
  } = {},
) {
  let previewRunning = true;
  const layout = await repoLayout(
    options.preview
      ? `specVersion: "0.1"
items:
  - id: live-preview
    type: preview
    approval: human
`
      : closeoutPolicy(options.paths),
  );
  const previewRuntime = createFakePreviewRuntime();
  let previewTurns = 0;
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-7",
      title: "Settings screen",
      description: null,
      subIssues: [],
    },
  ]);
  const log: { kind: string; body: string; options?: readonly unknown[] }[] = [];
  const { postProgress, askQuestion } = tracker;
  tracker.postProgress = async (update, requestOptions) => {
    if (!update.ephemeral) log.push({ kind: update.kind, body: update.body });
    await postProgress(update, requestOptions);
  };
  tracker.askQuestion = async (question, requestOptions) => {
    log.push({
      kind: "elicitation",
      body: question.body,
      ...(question.options ? { options: question.options } : {}),
    });
    await askQuestion(question, requestOptions);
  };
  let offset = 0;
  const clock: Clock = { now: () => Date.now() + offset, mono: () => performance.now() + offset };
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const evidenceRoot = path.join(layout.pawsRoot, "evidence");
  let spacing = 0;
  const store = createEvidenceStore({
    db,
    root: evidenceRoot,
    now: () => clock.now() + spacing,
  });
  const uploads: string[] = [];
  const files = createLinearFileTransfer({
    client: {
      async query(_query, variables) {
        uploads.push(String((variables as { filename?: string }).filename));
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload",
              assetUrl: ASSET,
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "token";
      },
    },
    fetch: async () => new Response(null, { status: 200 }),
  });
  const github = createFakeGitHub();
  const results: string[] = [];
  const prompts: string[] = [];
  const implementResults: string[] = [];
  let implementResult = "";
  const implement =
    options.implement ??
    ((worktree: string, n: number, prompt: string) =>
      n === 1 || prompt.includes('publish_artifact and checkId "visual-proof"')
        ? publishTwo(worktree, n)
        : []);
  const launch: AgentLaunch = (input) => {
    const n = results.length + 1;
    const scriptPath = path.join(layout.root, `script-${n}.json`);
    const resultPath = path.join(layout.root, `result-${n}.json`);
    results.push(resultPath);
    let steps: Step[] = [];
    if (input.purpose === "implement") {
      prompts.push(input.prompt);
      implementResults.push(resultPath);
      if (prompts.length === 1) implementResult = resultPath;
      steps = implement(input.worktree, prompts.length, input.prompt);
    }
    steps.push({ type: "end", stopReason: "end_turn" });
    writeFileSync(scriptPath, JSON.stringify({ model: "test-claude-model", steps }));
    return {
      command: process.execPath,
      args: [fakeAgent, resultPath, scriptPath],
      env: process.env,
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    files,
    evidence: {
      store: {
        async save(input) {
          const saved = await store.save(input);
          spacing += 10_000;
          return saved;
        },
      },
      publicUrl: options.publicUrl ?? "https://paws.example",
      root: evidenceRoot,
    },
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github),
    }),
    launch,
    publicUrl: options.publicUrl ?? "https://paws.example",
    ...(options.preview && !options.previewLocal
      ? {
          remoteExecution: {
            agentForSession: () => runAgent,
            agentForItem: () => async (input) => {
              const result = {
                role: input.role,
                sessionId: "preview-agent",
                identity: { session: "preview-agent", model: "fixture-model", provider: "fixture" },
                stopReason: "end_turn" as const,
                cancelled: false,
                timedOut: false,
                authRequired: false,
                agentExited: true,
              };
              if (input.prepareOnly) return result;
              await exec("git", ["-C", input.worktreePath, "config", "user.name", "Paws Test"]);
              await exec("git", [
                "-C",
                input.worktreePath,
                "config",
                "user.email",
                "paws-test@example.invalid",
              ]);
              writeFileSync(
                path.join(input.worktreePath, "README.md"),
                `Try the live product ${++previewTurns}\n`,
              );
              await exec("git", [
                "-C",
                input.worktreePath,
                "commit",
                "-am",
                "Add the fixture screen",
              ]);
              const head = (
                await exec("git", ["-C", input.worktreePath, "rev-parse", "HEAD"])
              ).stdout.trim();
              const request = PreviewRequestSchema.parse({
                command: ["bun", "run", "fixture"],
                port: 3123,
                checklist: ["Try the new screen"],
              });
              if (options.previewDeferred && previewTurns > 1)
                expect(input.reviewPreview?.required).toBe(true);
              if (options.previewDeferred && previewTurns === 1) {
                db.run("DELETE FROM runner_work WHERE run_id=?", [input.runId!]);
                db.run("UPDATE linear_session SET organization_id='org-1',team_id='team-1'");
                db.run("UPDATE workspace_user SET linear_user_id='delegator-1' WHERE id='user-1'");
                db.run("DELETE FROM runner_work WHERE run_id=?", [input.runId]);
                db.run(
                  "INSERT OR REPLACE INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('runner-1','0.1.53',?)",
                  [Date.now()],
                );
                await input.pullRequest?.update({ title: "Fixture", body: "Pending preview" });
                return result;
              }
              if (options.previewUnavailable) {
                if (options.previewIneligible) {
                  db.run("UPDATE linear_session SET organization_id='org-1',team_id='team-1'");
                  db.run(
                    "UPDATE workspace_user SET linear_user_id='delegator-1' WHERE id='user-1'",
                  );
                  const owner =
                    options.previewIneligible === "other-owner"
                      ? putWorkspaceUser(db, {
                          id: "other-owner",
                          linearUserId: "other-owner",
                          name: "Other",
                          email: "other@example.invalid",
                        })
                      : "user-1";
                  if (options.previewIneligible === "other-owner")
                    syncWorkspaceMember(db, {
                      workspaceId: "ws-1",
                      userId: owner,
                      role: "admin",
                      active: true,
                      teamIds: [],
                      now: Date.now(),
                    });
                  db.run(
                    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at,revoked_at) VALUES('ineligible','ws-1',?,'Ineligible','active',?,?,?)",
                    [
                      owner,
                      Date.now(),
                      options.previewIneligible === "offline" ? 0 : Date.now(),
                      options.previewIneligible === "revoked" ? Date.now() : null,
                    ],
                  );
                  for (const agent of ["codex", "claude", "grok", "opencode"])
                    db.run(
                      "INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('ineligible',?,1)",
                      [agent],
                    );
                  db.run(
                    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('ineligible','0.1.53',?)",
                    [Date.now()],
                  );
                }
                db.run(
                  "INSERT OR REPLACE INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('runner-1','0.1.48',?)",
                  [Date.now()],
                );
                await input.pullRequest?.update({ title: "Fixture", body: "Pending preview" });
                return result;
              }
              await runPreview({
                request,
                worktree: input.worktreePath,
                head,
                services: ["paws-preview-1"],
                path: "/usr/bin",
                lockNamespace: path.join(layout.root, "preview-locks"),
                signal: input.signal!,
                runtime: previewRuntime.io,
                ready: async (preview, signal) => {
                  if (options.previewReconnect) {
                    const host = new AbortController();
                    const first = input.reviewPreview!.review(preview, {
                      signal: host.signal,
                      isRunning: () => previewRunning,
                    });
                    while (!db.query("SELECT 1 FROM live_preview WHERE id=?").get(preview.id))
                      await Bun.sleep(10);
                    const questionId = db
                      .query<{ id: string }, [string]>(
                        "SELECT question_id AS id FROM live_preview WHERE id=?",
                      )
                      .get(preview.id)!.id;
                    const deadline = livePreviewForQuestion(db, questionId)!.expiresAt;
                    host.abort(new Error("Host reconnect"));
                    await expect(first).rejects.toThrow("Host reconnect");
                    expect(livePreviewForQuestion(db, questionId)).toBeNull();
                    offset += 40 * 60000;
                    const replay = input.reviewPreview!.review(preview, {
                      signal,
                      isRunning: () => previewRunning,
                    });
                    expect(livePreviewForQuestion(db, questionId)?.expiresAt).toBe(deadline);
                    return await replay;
                  }
                  // A ready event replay after reconnect must reuse the same question.
                  const replies = await Promise.all([
                    input.reviewPreview!.review(
                      { ...preview, expiresAt: 1, remainingMs: 3600000 },
                      { signal, isRunning: () => previewRunning },
                    ),
                    input.reviewPreview!.review(
                      { ...preview, expiresAt: 1, remainingMs: 3600000 },
                      { signal, isRunning: () => previewRunning },
                    ),
                  ]);
                  return replies[0]!;
                },
                stopped: (id) => input.reviewPreview?.stopped?.(id),
              });
              await input.pullRequest?.update({
                title: "Add the fixture screen",
                body: "Try the product before publishing.",
              });
              return result;
            },
          },
        }
      : {}),
    ...(options.gate ? { closeoutGate: () => options.gate! } : {}),
  });
  await orchestrator.onLinearEvent(created());
  db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
  saveSchedulingContext(db, {
    itemId: listWorkItems(db)[0]!.id,
    projectId: "project-1",
    projectLeadId: "lead-1",
  });
  const running = jobs.tick();
  const runnerId = leaseActiveRun(db);
  if (!options.gate?.held && !options.preview) {
    await running;
    await outboxIdle(outbox);
    expect(listEvidence(db, listWorkItems(db)[0]!.id).length).toBeGreaterThanOrEqual(2);
  }
  return {
    db,
    previewRuntime,
    losePreviewRunner() {
      previewRunning = false;
    },
    turn: running,
    bare: layout.bare,
    root: layout.root,
    async until(done: () => boolean) {
      const deadline = Date.now() + 30_000;
      while (!done()) {
        if (Date.now() > deadline)
          throw new Error(
            JSON.stringify({
              items: listWorkItems(db),
              jobs: listJobs(db),
              calls: previewRuntime.calls,
            }),
          );
        await outboxIdle(outbox);
        await Bun.sleep(20);
      }
    },
    tracker,
    log,
    github,
    prompts,
    uploads,
    orchestrator,
    evidenceRoot,
    received(n: number) {
      const result = JSON.parse(readFileSync(implementResults[n]!, "utf8")) as {
        prompts?: { type: string; text?: string }[][];
      };
      return (result.prompts ?? []).flat();
    },
    runnerId: await runnerId,
    advance(ms: number) {
      offset += ms;
    },
    async tickAll() {
      while ((await jobs.tick()) !== null);
      await outboxIdle(outbox);
    },
    async driveUntil(done: () => boolean) {
      const deadline = Date.now() + 90_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(JSON.stringify(listJobs(db)));
        const state = listWorkItems(db)[0]!.state;
        if (state === "failed")
          throw new Error(`task ${state}: ${JSON.stringify(listWorkItems(db)[0])}`);
        const job = await jobs.tick();
        await outboxIdle(outbox);
        if (job === null) await Bun.sleep(20);
      }
    },
    reminders() {
      return tracker.questions.filter((question) => question.body.startsWith(REMINDED)).length;
    },
    /** The signed-in Paws account of Linear user `by`, for the Audit history row. */
    actor(by: string) {
      const userId =
        db
          .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id = ?")
          .get(by)?.id ??
        putWorkspaceUser(db, {
          id: `user-${by}`,
          linearUserId: by,
          name: by,
          email: `${by}@example.invalid`,
        });
      const workspaceId = db.query<{ id: string }, []>("SELECT id FROM workspace").get()!.id;
      return { workspaceId, userId, name: by };
    },
    /** Approve on the item page: the only way a person approves the screens. */
    async approve(by = "delegator-1", questionId = findOpenQuestion(db, "ses_1")?.id) {
      if (questionId === undefined) throw new Error("No visual review is waiting");
      return orchestrator.decideLinkAsk({
        questionId,
        decision: "approve",
        note: null,
        answeredBy: by,
        actor: this.actor(by),
      });
    },
    notes(body: string) {
      return tracker.progress.filter((update) => update.body === body).length;
    },
    lastPublication() {
      const result = JSON.parse(readFileSync(implementResult, "utf8")) as {
        artifact?: { text?: string };
      };
      return result.artifact?.text;
    },
    async close() {
      await orchestrator.shutdown();
      db.close();
      await layout.cleanup();
    },
  };
}

async function outboxIdle(outbox: OutboxDispatcher): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const claimed = outbox.tick();
    await outbox.idle();
    if (claimed.length === 0) return;
  }
}

function leaseActiveRun(db: Database): Promise<string> {
  return (async () => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const item = listWorkItems(db)[0];
      const run = item?.currentRunId ? getRun(db, item.currentRunId) : null;
      if (run?.status === "active") return attachLease(db, run.id);
      await Bun.sleep(10);
    }
    throw new Error("implement run did not become active");
  })();
}

function attachLease(db: Database, runId: string): string {
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
  syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    ["runner-1", "ws-1", userId, "Runner", now, now],
  );
  for (const agent of ["codex", "claude", "grok", "opencode"]) {
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [
      "runner-1",
      agent,
    ]);
  }
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", ["runner-1"]);
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
    [runId, "runner-1", "ws-1", `cmd-${runId}`, now + 60_000],
  );
  return "runner-1";
}

async function repoLayout(policy: string) {
  const root = await mkdtemp(path.join(tmpdir(), "paws-visual-review-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await mkdir(path.join(seed, ".agents"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), policy);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return { root, bare, pawsRoot, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function created(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

/** A follow-up in the session after Accept: the work goes back to the agent. */
function followUp(): AcceptedLinearEvent {
  return prompted("Also tighten the copy", "delegator-1", "activity:follow-up");
}

function prompted(body: string, actorId: string, key = "activity:ans"): AcceptedLinearEvent {
  return {
    dedupeKey: key,
    deliveryId: `del-${key}`,
    source: "webhook",
    action: "prompted",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: key.replace("activity:", ""),
    actorId,
    body,
    signal: null,
    updatedAtMs: Date.now() + 1_000,
    payload: "{}",
  };
}
