import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { approvalsAtHead, publishedAtHead } from "./published";
import { scrubCommandEnv } from "./run/env";
import type { EvidenceApproval, PublishedEvidence } from "./types";

const ITEMS = [{ id: "visual-proof", paths: ["web/"] }];
const PAGE = Array.from({ length: 30 }, (_, n) => `line ${n + 1}`);

let repo: string;

function git(...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Paws Test", "-c", "user.email=paws-test@example.invalid", ...args],
    { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function write(file: string, lines: readonly string[]): void {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), `${lines.join("\n")}\n`);
}

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "--no-gpg-sign", "-m", message);
  return git("rev-parse", "HEAD");
}

function edit(lines: readonly string[], at: number, text: string): string[] {
  return lines.map((line, index) => (index === at ? text : line));
}

/** Main and a task that changes the page, approved at its head. */
function taskApproved(): { approved: string } {
  git("init", "-q", "-b", "main");
  write("web/page.tsx", PAGE);
  write("server.ts", ["serve()"]);
  commit("init");
  git("checkout", "-q", "-b", "task");
  write("web/page.tsx", edit(PAGE, 2, "task line 3"));
  return { approved: commit("task: change the page") };
}

/** Main moves under the check's paths and elsewhere, then the task rebases onto it. */
function mainMovesAndTaskRebases(): { head: string; base: string } {
  git("checkout", "-q", "main");
  write("web/page.tsx", edit(PAGE, 24, "main line 25"));
  write("web/other.tsx", ["export const other = 1;"]);
  write("server.ts", ["serve({ port: 8787 })"]);
  commit("main: unrelated change");
  git("checkout", "-q", "task");
  git("rebase", "-q", "main");
  return { head: git("rev-parse", "HEAD"), base: git("merge-base", "HEAD", "main") };
}

function approval(approved: string): EvidenceApproval {
  return {
    task: "task",
    checkId: "visual-proof",
    evidenceIds: ["ev-1"],
    approvedBy: "Pascal",
    approvedAt: "2026-10-23T18:00:00.000Z",
    commit: approved,
  };
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "paws-published-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("an accepted visual review across a rebase", () => {
  test("a rebase that only brings in main's changes keeps the accepted review", async () => {
    const { approved } = taskApproved();
    const { head, base } = mainMovesAndTaskRebases();
    expect(head).not.toBe(approved);
    const approvals = [approval(approved)];
    expect(await approvalsAtHead(repo, head, approvals, ITEMS, scrubCommandEnv(), base)).toEqual(
      approvals,
    );
    // Comparing whole trees still sees main's page change, which is why the base is needed.
    expect(await approvalsAtHead(repo, head, approvals, ITEMS, scrubCommandEnv())).toEqual([]);
  });

  test("the published screenshots stay with the kept review", async () => {
    const { approved } = taskApproved();
    const { head, base } = mainMovesAndTaskRebases();
    const published: PublishedEvidence[] = [
      { id: "ev-1", checkId: "visual-proof", media: "image", commit: approved },
    ];
    expect(
      await publishedAtHead(repo, head, published, ITEMS, scrubCommandEnv(), base),
    ).toHaveLength(1);
  });

  test("a change to the task's own screens after the rebase asks again", async () => {
    const { approved } = taskApproved();
    const { base } = mainMovesAndTaskRebases();
    write("web/page.tsx", edit(edit(PAGE, 24, "main line 25"), 2, "task line 3, shorter"));
    const head = commit("task: change the page again");
    expect(
      await approvalsAtHead(repo, head, [approval(approved)], ITEMS, scrubCommandEnv(), base),
    ).toEqual([]);
  });

  test("a conflict resolved in main's favour changes the task's screens and asks again", async () => {
    const { approved } = taskApproved();
    git("checkout", "-q", "main");
    write("web/page.tsx", edit(PAGE, 2, "main line 3"));
    commit("main: same line");
    git("checkout", "-q", "task");
    // In a rebase "ours" is main, so the task's edit to line 3 is dropped.
    git("rebase", "-q", "-X", "ours", "main");
    const head = git("rev-parse", "HEAD");
    const base = git("merge-base", "HEAD", "main");
    expect(
      await approvalsAtHead(repo, head, [approval(approved)], ITEMS, scrubCommandEnv(), base),
    ).toEqual([]);
  });

  test("main editing two lines from the task's edit keeps the accepted review", async () => {
    const { approved } = taskApproved();
    git("checkout", "-q", "main");
    write("web/page.tsx", edit(PAGE, 4, "main line 5"));
    commit("main: nearby line");
    git("checkout", "-q", "task");
    git("rebase", "-q", "main");
    const head = git("rev-parse", "HEAD");
    const base = git("merge-base", "HEAD", "main");
    const approvals = [approval(approved)];
    expect(await approvalsAtHead(repo, head, approvals, ITEMS, scrubCommandEnv(), base)).toEqual(
      approvals,
    );
  });

  test("a different image after the rebase asks again, the same image does not", async () => {
    taskApproved();
    writeFileSync(path.join(repo, "web/shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const approved = commit("task: add an image");
    const { head, base } = mainMovesAndTaskRebases();
    const approvals = [approval(approved)];
    expect(await approvalsAtHead(repo, head, approvals, ITEMS, scrubCommandEnv(), base)).toEqual(
      approvals,
    );
    writeFileSync(path.join(repo, "web/shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9]));
    const changed = commit("task: change the image");
    expect(await approvalsAtHead(repo, changed, approvals, ITEMS, scrubCommandEnv(), base)).toEqual(
      [],
    );
  });
});
