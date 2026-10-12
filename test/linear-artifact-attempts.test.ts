import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import {
  artifactPublicationReady,
  beginArtifactAttempt,
  claimOutboxHeads,
  enqueueOutbox,
  listOutbox,
  OutboxDispatcher,
  stopOutboxSession,
  completeArtifactAttempt,
  insertQueuedItem,
  listArtifacts,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, createLinearFileTransfer } from "../src/linear";
import { createLinearArtifactPublisher, deliverLinearOutbox } from "../src/loop";
import { tempHome } from "./helpers";

function setup() {
  const home = tempHome();
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const database = join(home, "paws.db");
  let db = openDatabase(database);
  migrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  let uploadFailure = false;
  let sequence = 0;
  const files = createLinearFileTransfer({
    client: {
      async query() {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload?signature=private",
              assetUrl: "https://uploads.linear.app/workspace/result",
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "host-only-token";
      },
    },
    fetch: async (_url, request) =>
      new Response(null, { status: request?.method === "PUT" ? (uploadFailure ? 503 : 200) : 404 }),
  });
  return {
    get db() {
      return db;
    },
    failUpload(value: boolean) {
      uploadFailure = value;
    },
    reopen() {
      db.close();
      db = openDatabase(database);
      migrate(db);
    },
    async run(steps: FakeScript["steps"]) {
      const script = join(home, `script-${++sequence}.json`);
      const trace = join(home, `trace-${sequence}.json`);
      writeFileSync(script, JSON.stringify({ steps: [...steps, { type: "end" }] }));
      const result = await runAgent({
        role: "implementer",
        itemId: "item",
        runId: `run-${sequence}`,
        prompt: "Publish the requested files.",
        worktreePath: workspace,
        pawsRoot: home,
        home,
        checkpoint: false,
        command: process.execPath,
        args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        publishArtifact: createLinearArtifactPublisher({
          db,
          files,
          secretsDir: join(home, "secrets"),
          itemId: "item",
          issueId: "issue",
          sessionId: "session",
        }),
      });
      return { result, trace: JSON.parse(readFileSync(trace, "utf8")) };
    },
  };
}

test("a missing file invocation remains required after end_turn and database reopen", async () => {
  const f = setup();
  try {
    const first = await f.run([{ type: "publish_artifact", path: "shot.png" }]);
    expect(first.result.stopReason).toBe("end_turn");
    expect(first.trace.artifact.ok).toBe(false);
    expect(listArtifacts(f.db, "item")).toHaveLength(0);
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    f.reopen();
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    await f.run([
      { type: "fs_write", path: "shot.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "shot.png" },
    ]);
    expect(artifactPublicationReady(f.db, "item")).toBe(true);
    expect(listArtifacts(f.db, "item")[0]?.state).toBe("uploaded");
  } finally {
    f.db.close();
  }
});

test("a corrected unsafe path recovers the same explicit deliverable without storing the rejected path", async () => {
  const f = setup();
  try {
    await f.run([
      {
        type: "publish_artifact",
        path: "/private/secrets/shot.png",
        displayName: "Screenshot.png",
      },
    ]);
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    const rows = f.db.query("SELECT * FROM linear_artifact_attempt").all();
    expect(JSON.stringify(rows)).not.toContain("/private/secrets");
    await f.run([
      { type: "fs_write", path: "safe.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "safe.png", displayName: "Screenshot.png" },
    ]);
    expect(artifactPublicationReady(f.db, "item")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("another deliverable with the same basename cannot clear a missing publication", async () => {
  const f = setup();
  try {
    await f.run([{ type: "publish_artifact", path: "required/proof.png" }]);
    await f.run([
      { type: "fs_write", path: "other/proof.png", content: "Other bytes" },
      { type: "publish_artifact", path: "other/proof.png" },
    ]);
    expect(listArtifacts(f.db, "item")[0]?.state).toBe("uploaded");
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    await f.run([
      { type: "fs_write", path: "required/proof.png", content: "Required bytes" },
      { type: "publish_artifact", path: "required/proof.png" },
    ]);
    expect(artifactPublicationReady(f.db, "item")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("a failed PUT at an old path is superseded by the same named deliverable at a corrected path", async () => {
  const f = setup();
  try {
    f.failUpload(true);
    await f.run([
      { type: "fs_write", path: "old.png", content: "Old bytes" },
      { type: "publish_artifact", path: "old.png", displayName: "Screenshot.png" },
    ]);
    expect(listArtifacts(f.db, "item")[0]?.state).toBe("failed");
    f.reopen();
    f.failUpload(false);
    await f.run([
      { type: "fs_write", path: "correct.png", content: "Correct bytes" },
      { type: "publish_artifact", path: "correct.png", displayName: "Screenshot.png" },
    ]);
    expect(
      listArtifacts(f.db, "item")
        .map((row) => row.state)
        .sort(),
    ).toEqual(["failed", "uploaded"]);
    expect(artifactPublicationReady(f.db, "item")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("a late earlier success does not resolve a newer failed invocation of the same deliverable", () => {
  const f = setup();
  try {
    const first = beginArtifactAttempt(f.db, "item", "same-identity");
    const retry = beginArtifactAttempt(f.db, "item", "same-identity");
    completeArtifactAttempt(f.db, "item", "same-identity", first);
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    f.reopen();
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    completeArtifactAttempt(f.db, "item", "same-identity", retry);
    expect(artifactPublicationReady(f.db, "item")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("requested issue cards survive a missing file and reopen before a corrected-path retry", async () => {
  const f = setup();
  try {
    await f.run([
      {
        type: "publish_artifact",
        path: "missing.png",
        displayName: "Screenshot.png",
        attachToIssue: true,
      },
    ]);
    expect(listOutbox(f.db, "session")).toHaveLength(0);
    f.reopen();
    await f.run([
      { type: "fs_write", path: "fixed.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "fixed.png", displayName: "Screenshot.png" },
    ]);
    const artifact = listArtifacts(f.db, "item")[0]!;
    const cards = listOutbox(f.db, "session").filter((row) => row.op === "linear.attachment");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.payload).toEqual({
      id: artifact.id,
      itemId: "item",
      issueId: "issue",
      title: "Screenshot.png",
      url: artifact.assetUrl!,
    });
    const tracker = createFakeTracker();
    await deliverLinearOutbox(cards[0]!, tracker, async () => {});
    expect(tracker.attachments).toEqual([
      { id: artifact.id, issueId: "issue", title: "Screenshot.png", url: artifact.assetUrl! },
    ]);
    expect(artifact.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await f.run([
      {
        type: "publish_artifact",
        path: "fixed.png",
        displayName: "Screenshot.png",
        attachToIssue: true,
      },
    ]);
    expect(
      listOutbox(f.db, "session").filter((row) => row.op === "linear.attachment"),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("ordinary publication does not create a requested issue card", async () => {
  const f = setup();
  try {
    await f.run([
      { type: "fs_write", path: "proof.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "proof.png" },
    ]);
    expect(listOutbox(f.db, "session").map((row) => row.op)).toEqual(["activity"]);
  } finally {
    f.db.close();
  }
});

test("a requested card retries ahead of the terminal reply and is fenced by Stop", async () => {
  const f = setup();
  try {
    await f.run([
      { type: "fs_write", path: "proof.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "proof.png", attachToIssue: true },
    ]);
    const now = Date.now();
    enqueueOutbox(f.db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: "final",
      now,
      payload: { sessionId: "session", kind: "response", body: "Done" },
    });
    const dispatcher = new OutboxDispatcher(
      f.db,
      { now: () => now, mono: () => now },
      { backoffBaseMs: 1000 },
    );
    dispatcher.setHandler(async () => {
      throw new Error("temporary failure");
    });
    expect(dispatcher.tick()[0]!.op).toBe("linear.attachment");
    await dispatcher.idle();
    f.reopen();
    expect(claimOutboxHeads(f.db, { now: now + 1 })).toHaveLength(0);
    expect(listOutbox(f.db, "session").find((row) => row.idempotencyKey === "final")?.status).toBe(
      "pending",
    );
    stopOutboxSession(f.db, "linear", "session", now + 2);
    expect(claimOutboxHeads(f.db, { now: now + 2000 })).toHaveLength(0);
    expect(listOutbox(f.db, "session").every((row) => row.status === "dropped")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("exhausted attachment and image delivery preserve a claimable final response after reopen", async () => {
  const f = setup();
  try {
    await f.run([
      { type: "fs_write", path: "proof.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "proof.png", attachToIssue: true },
    ]);
    f.db.run("UPDATE outbox SET max_attempts = 1");
    enqueueOutbox(f.db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: "final",
      payload: { sessionId: "session", kind: "response", body: "Done" },
    });
    const dispatcher = new OutboxDispatcher(f.db, { now: Date.now, mono: Date.now });
    dispatcher.setHandler(async () => {
      throw new Error("delivery exhausted");
    });
    for (const op of ["linear.attachment", "activity"]) {
      expect(dispatcher.tick()[0]?.op).toBe(op);
      await dispatcher.idle();
    }
    f.reopen();
    expect(
      listOutbox(f.db, "session")
        .slice(0, 2)
        .map((row) => row.status),
    ).toEqual(["dead", "dead"]);
    expect(claimOutboxHeads(f.db)[0]?.idempotencyKey).toBe("final");
  } finally {
    f.db.close();
  }
});

test("a malformed attachment flag still leaves its publication attempt required", async () => {
  const f = setup();
  try {
    await f.run([
      { type: "fs_write", path: "proof.png", content: "PNG bytes" },
      { type: "publish_artifact", path: "proof.png", attachToIssue: "true" as unknown as boolean },
    ]);
    expect(artifactPublicationReady(f.db, "item")).toBe(false);
    expect(listOutbox(f.db, "session")).toHaveLength(0);
    await f.run([{ type: "publish_artifact", path: "proof.png" }]);
    expect(artifactPublicationReady(f.db, "item")).toBe(true);
    expect(listOutbox(f.db, "session").some((row) => row.op === "linear.attachment")).toBe(false);
  } finally {
    f.db.close();
  }
});
