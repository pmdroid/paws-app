import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorPath, worktreePath } from "../src/acp";
import { FakeClock, type RepositoryBinding } from "../src/core";
import {
  beginImplementRun,
  enterMergeQueue,
  getTaskMergeSettings,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listCloseoutRounds,
  migrate,
  openDatabase,
  OutboxDispatcher,
  recordConfirmedRemoteMerge,
  type WorkItemRecord,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { attachOrchestrator, itemPathId } from "../src/loop";

type Operations = {
  startCloseoutRound(item: WorkItemRecord, head: string): Promise<void>;
  mergeSettingsFor(item: WorkItemRecord): Promise<unknown>;
  completeMerge(item: WorkItemRecord, repository: RepositoryBinding): Promise<void>;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paws-catch-journal-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const lines: string[] = [];
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    clock,
    tracker,
    journal: (line) => lines.push(line),
  });
  const item = insertQueuedItem(db, { id: "item-715", sessionKey: "" });
  return {
    root,
    db,
    tracker,
    lines,
    item,
    operations: orchestrator as unknown as Operations,
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("startCloseoutRound journals a failed retry baseline and preserves the fallback", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "closeout", "evidence", itemPathId(f.item));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "evidence"), "not a directory");
    await f.operations.startCloseoutRound(f.item, "new-head");
    expect(listCloseoutRounds(f.db, f.item.id)).toEqual([]);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("item=item-715");
    expect(f.lines[0]).toContain("operation=orchestrator.startCloseoutRound");
    expect(f.lines[0]).toContain("error=could not read the evidence directory");
  } finally {
    await f.close();
  }
});

test("mergeSettingsFor journals the read failure once and leaves settings retryable", async () => {
  const f = await fixture();
  try {
    f.tracker.issueMergeContext = async () => {
      throw new Error("Linear context unavailable");
    };
    await f.operations.mergeSettingsFor(f.item);
    expect(getTaskMergeSettings(f.db, f.item.id)).toBeNull();
    expect(f.lines).toEqual([
      "catch item=item-715 operation=orchestrator.mergeSettingsFor.issueMergeContext error=Linear context unavailable",
    ]);
    f.tracker.issueMergeContext = async () => ({ projectId: null, labels: [] });
    await f.operations.mergeSettingsFor(f.item);
    expect(getTaskMergeSettings(f.db, f.item.id)).not.toBeNull();
    expect(f.lines).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("removeWorktree failure is journaled once after the confirmed merge", async () => {
  const f = await fixture();
  try {
    const repository = { owner: "test", repo: "repo", remoteUrl: "unused" };
    beginImplementRun(f.db, f.item.id, 1_000);
    enterMergeQueue(f.db, f.item.id, { phase: "merge_queue" });
    recordConfirmedRemoteMerge(f.db, {
      itemId: f.item.id,
      repositoryOwner: repository.owner,
      repositoryName: repository.repo,
      pullNumber: 715,
      pullUrl: null,
      mergeSha: "merged-head",
      confirmedAt: 1_000,
    });

    await mkdir(mirrorPath(f.root, repository.owner, repository.repo), { recursive: true });
    await mkdir(worktreePath(f.root, itemPathId(f.item)), { recursive: true });
    await f.operations.completeMerge(getWorkItem(f.db, f.item.id)!, repository);
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("merged");
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("item=item-715");
    expect(f.lines[0]).toContain("operation=orchestrator.completeMerge.removeWorktree");
    expect(f.lines[0]).toContain("not a git repository");
    expect(f.lines[0]).not.toContain("\n");
  } finally {
    await f.close();
  }
});
