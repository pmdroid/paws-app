import { describe, expect, test } from "bun:test";
import { STATUS_EDIT_INTERVAL_MS } from "../src/comments";
import { FakeClock, NotImplementedError } from "../src/core";
import {
  PAWS_LABEL_AWAITING,
  PAWS_LABEL_DONE,
  PAWS_LABEL_RUNNING,
  createFakeGitHubComments,
  createGitHubCommentTracker,
} from "../src/ghcomments";
import type { FakeGitHubComments } from "../src/ghcomments";

const SESSION = "github:acme/app#7";

function setup(options?: { trustedAssociations?: readonly string[]; labels?: boolean }) {
  const clock = new FakeClock(1_000_000);
  const github = createFakeGitHubComments({ clock, selfLogin: "pascal" });
  const tracker = createGitHubCommentTracker({
    request: github.request,
    owner: "acme",
    repo: "app",
    clock,
    selfLogin: "pascal",
    ...(options?.trustedAssociations === undefined
      ? {}
      : { trustedAssociations: options.trustedAssociations }),
    ...(options?.labels === undefined ? {} : { labels: options.labels }),
  });
  return { clock, github, tracker };
}

function bodies(github: FakeGitHubComments): string[] {
  return github.comments
    .filter((comment) => comment.issueNumber === 7)
    .map((comment) => comment.body);
}

describe("GitHub comment tracker", () => {
  test("status comment is created once and edited at most every 5 seconds", async () => {
    const { clock, github, tracker } = setup();
    await tracker.postProgress({ sessionId: SESSION, kind: "thought", body: "one" });
    await tracker.postProgress({ sessionId: SESSION, kind: "action", body: "two" });
    clock.advance(STATUS_EDIT_INTERVAL_MS - 1);
    await tracker.postProgress({ sessionId: SESSION, kind: "thought", body: "three" });

    expect(github.commentCreates).toBe(1);
    expect(github.commentUpdates).toBe(0);
    expect(bodies(github)).toEqual(["Paws: one\n\n<!-- paws -->"]);

    clock.advance(1);
    await tracker.postProgress({ sessionId: SESSION, kind: "thought", body: "four" });
    await tracker.postProgress({ sessionId: SESSION, kind: "thought", body: "five" });
    expect(github.commentUpdates).toBe(1);
    expect(bodies(github)).toEqual(["Paws: four\n\n<!-- paws -->"]);

    clock.advance(STATUS_EDIT_INTERVAL_MS);
    await tracker.sync(SESSION);
    expect(github.commentCreates).toBe(1);
    expect(github.commentUpdates).toBe(2);
    expect(bodies(github)).toEqual(["Paws: five\n\n<!-- paws -->"]);
    expect(github.labelsOn(7)).toEqual([PAWS_LABEL_RUNNING]);
  });

  test("final evidence is its own comment", async () => {
    const { github, tracker } = setup();
    await tracker.postProgress({ sessionId: SESSION, kind: "thought", body: "working" });
    await tracker.postProgress({
      sessionId: SESSION,
      kind: "response",
      body: "Merged acme/app#7.",
    });
    expect(bodies(github)).toEqual([
      "Paws: working\n\n<!-- paws -->",
      "Paws: Merged acme/app#7.\n\n<!-- paws -->",
    ]);
    expect(github.labelsOn(7)).toEqual([PAWS_LABEL_RUNNING]);
    await tracker.setStatus({ linearIssueId: SESSION, stateType: "completed" });
    expect(github.labelsOn(7)).toEqual([PAWS_LABEL_DONE]);
  });

  test("a same-user reply without the marker resumes, and a marked reply does not", async () => {
    const { clock, github, tracker } = setup();
    await tracker.askQuestion({
      sessionId: SESSION,
      body: "Which format?",
      options: ["csv", "json"],
    });
    expect(tracker.phase(SESSION)).toBe("parked");
    const question = github.comments.find((comment) => comment.body.includes("<!-- paws:q:"));
    expect(question?.body.startsWith("Paws:")).toBe(true);
    expect(question?.body).toContain("1. csv");
    expect(question?.body).toContain("2. json");
    expect(question?.body).toContain("Which format?");
    expect(github.labelsOn(7)).toEqual([PAWS_LABEL_AWAITING]);

    clock.advance(1);
    github.post({
      issueNumber: 7,
      login: "pascal",
      association: "NONE",
      body: "csv\n<!-- paws -->",
    });
    expect((await tracker.sync(SESSION)).resumed).toEqual([]);
    expect(tracker.phase(SESSION)).toBe("parked");

    clock.advance(1);
    github.post({
      issueNumber: 7,
      login: "pascal",
      association: "NONE",
      body: "csv",
    });
    const synced = await tracker.sync(SESSION);
    expect(synced.resumed).toEqual([{ questionId: "q-1", answer: "csv", answeredBy: "pascal" }]);
    expect(tracker.phase(SESSION)).toBe("resumed");
  });

  test("an untrusted reply is ignored", async () => {
    const { clock, github, tracker } = setup();
    await tracker.askQuestion({ sessionId: SESSION, body: "Ship?" });

    clock.advance(1);
    github.post({ issueNumber: 7, login: "eve", association: "CONTRIBUTOR", body: "yes" });
    github.post({ issueNumber: 7, login: "mallory", association: "NONE", body: "yes" });
    expect((await tracker.sync(SESSION)).resumed).toEqual([]);
    expect(tracker.phase(SESSION)).toBe("parked");

    clock.advance(1);
    github.post({ issueNumber: 7, login: "sam", association: "MEMBER", body: "no" });
    const synced = await tracker.sync(SESSION);
    expect(synced.resumed).toEqual([{ questionId: "q-1", answer: "no", answeredBy: "sam" }]);
    expect(tracker.phase(SESSION)).toBe("resumed");
  });

  test("a custom association list is the trust boundary, plus the authenticated user", async () => {
    const { clock, github, tracker } = setup({ trustedAssociations: ["OWNER"] });
    await tracker.askQuestion({ sessionId: SESSION, body: "Ship?" });

    clock.advance(1);
    github.post({ issueNumber: 7, login: "sam", association: "MEMBER", body: "no" });
    expect((await tracker.sync(SESSION)).resumed).toEqual([]);

    clock.advance(1);
    github.post({ issueNumber: 7, login: "pascal", association: "NONE", body: "yes" });
    const synced = await tracker.sync(SESSION);
    expect(synced.resumed).toEqual([{ questionId: "q-1", answer: "yes", answeredBy: "pascal" }]);
  });

  test("/paws stop from a trusted author stops, and an untrusted stop does not", async () => {
    const { clock, github, tracker } = setup();
    await tracker.askQuestion({ sessionId: SESSION, body: "Ship?" });

    clock.advance(1);
    github.post({ issueNumber: 7, login: "eve", association: "NONE", body: "/paws stop" });
    expect((await tracker.sync(SESSION)).stopped).toEqual([]);
    expect(tracker.phase(SESSION)).toBe("parked");

    clock.advance(1);
    github.post({
      issueNumber: 7,
      login: "sam",
      association: "COLLABORATOR",
      body: "please\n/paws stop",
    });
    const synced = await tracker.sync(SESSION);
    expect(synced.stopped.map((command) => command.itemId)).toEqual([SESSION]);
    expect(tracker.phase(SESSION)).toBe("stopped");

    clock.advance(1);
    github.post({ issueNumber: 7, login: "sam", association: "COLLABORATOR", body: "yes" });
    expect((await tracker.sync(SESSION)).resumed).toEqual([]);
    expect(tracker.phase(SESSION)).toBe("stopped");
  });

  test("setStatus writes the status comment and swaps the paws label", async () => {
    const { clock, github, tracker } = setup();
    await tracker.setStatus({ linearIssueId: SESSION, stateType: "started" });
    expect(bodies(github)).toEqual(["Paws: Started.\n\n<!-- paws -->"]);
    expect(github.labelsOn(7)).toEqual([PAWS_LABEL_RUNNING]);

    clock.advance(STATUS_EDIT_INTERVAL_MS);
    await tracker.setStatus({ linearIssueId: SESSION, stateType: "completed" });
    expect(bodies(github)).toEqual(["Paws: Done.\n\n<!-- paws -->"]);
    expect(github.labelsOn(7)).toEqual([PAWS_LABEL_DONE]);

    clock.advance(STATUS_EDIT_INTERVAL_MS);
    await tracker.setStatus({ linearIssueId: SESSION, stateType: "canceled" });
    expect(bodies(github)).toEqual(["Paws: Canceled.\n\n<!-- paws -->"]);
    expect(github.labelsOn(7)).toEqual([]);
  });

  test("labels can be left off", async () => {
    const { github, tracker } = setup({ labels: false });
    await tracker.postProgress({ sessionId: SESSION, kind: "thought", body: "one" });
    expect(github.calls.some((call) => call.path.includes("/labels"))).toBe(false);
    expect(github.labelsOn(7)).toEqual([]);
  });

  test("epic reads stay unimplemented", async () => {
    const { tracker } = setup();
    await expect(tracker.loadEpic(SESSION)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(tracker.listDeps(SESSION)).rejects.toBeInstanceOf(NotImplementedError);
  });
});
