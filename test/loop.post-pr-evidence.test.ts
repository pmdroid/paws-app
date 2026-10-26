import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import { enqueueOutbox, insertQueuedItem, listOutbox, OutboxDispatcher } from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeTracker } from "../src/linear";
import { ask, createEvidenceArtifactPublisher, deliverLinearOutbox } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

test.each([true, false])(
  "post-PR evidence replaces attachments and ask reaches Linear, uploads %s",
  async (uploadEnabled) => {
    const db = tempDb();
    const home = tempHome();
    try {
      insertQueuedItem(db, { id: "item", sessionKey: "session" });
      db.run("UPDATE work_item SET state='verifying' WHERE id='item'");
      const tracker = createFakeTracker();
      const root = join(home, "evidence");
      const publisher = createEvidenceArtifactPublisher({
        db,
        itemId: "item",
        sessionId: "session",
        evidence: createEvidenceStore({ db, root }),
        publicUrl: "https://paws.example",
        uploads: uploadEnabled,
      });
      let uploads = 0;
      const dispatcher = new OutboxDispatcher(db, new FakeClock(Date.now()));
      dispatcher.setHandler((row, context) =>
        deliverLinearOutbox(row, tracker, async () => {}, context, db, {
          root,
          files: {
            upload: async ({ filename, contentType, bytes }) => ({
              filename,
              contentType,
              size: bytes.length,
              assetUrl: `https://uploads.linear.app/proof-${++uploads}`,
            }),
            prepareUpload: async () => {
              throw new Error("unexpected prepare");
            },
            uploadPrepared: async () => {
              throw new Error("unexpected prepared upload");
            },
            download: async () => {
              throw new Error("unexpected download");
            },
          },
        }),
      );
      const flush = async () => {
        while (dispatcher.tick().length) await dispatcher.idle();
      };
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        delivery: "ordered",
        priority: 10,
        idempotencyKey: "delayed-progress",
        payload: {
          sessionId: "session",
          kind: "thought",
          body: "Queued before the PR, delivered later",
        },
      });
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        delivery: "ordered",
        idempotencyKey: "pull-request-ready:item:0",
        payload: { sessionId: "session", kind: "response", body: "Opened PR #1" },
      });
      await flush();
      for (const [index, headCommit] of ["a".repeat(40), "b".repeat(40)].entries()) {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]);
        await publisher.publish(
          {
            path: "proof.png",
            displayName: "proof.png",
            mimeType: "image/png",
            bytes: new Blob([bytes]),
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          {
            itemId: "item",
            runId: "run",
            worktreePath: home,
            role: "implementer",
            signal: new AbortController().signal,
            evidence: { checkId: "browser", attempt: 1, headCommit },
          },
        );
        await flush();
        expect(tracker.attachments).toHaveLength(1);
        if (uploadEnabled)
          expect(tracker.attachments[0]?.url).toBe(`https://uploads.linear.app/proof-${index + 1}`);
        else expect(tracker.attachments[0]?.url).toStartWith("https://paws.example/evidence/");
      }
      expect(uploads).toBe(uploadEnabled ? 2 : 0);
      expect(
        listOutbox(db)
          .filter((row) => row.op === "linear.evidence")
          .every((row) => (row.payload as { uploadOnly?: boolean }).uploadOnly),
      ).toBe(true);
      for (const kind of ["thought", "action", "error", "response", "elicitation"]) {
        enqueueOutbox(db, {
          target: "linear",
          op: "activity",
          orderingKey: "session",
          delivery: "ordered",
          idempotencyKey: `late:${kind}`,
          payload: { sessionId: "session", kind, body: "Late activity" },
        });
      }
      enqueueOutbox(db, {
        target: "linear",
        op: "elicitation",
        orderingKey: "session",
        delivery: "ordered",
        idempotencyKey: "unowned-question",
        payload: { sessionId: "session", body: "Not from ask" },
      });
      await flush();
      expect(tracker.progress.map(({ kind }) => kind)).toEqual(["response"]);
      expect(tracker.questions).toHaveLength(0);
      ask(db, { itemId: "item", runId: null, sessionId: "session" }, "agent", "Which layout?", {
        options: ["Wide", "Narrow"],
      });
      await flush();
      expect(tracker.questions).toHaveLength(1);
      expect(tracker.questions[0]?.body).toContain("Which layout?");
    } finally {
      db.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
