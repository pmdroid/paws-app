import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { tempDb } from "./helpers";
import { beginImplementRun, insertQueuedItem } from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerHealth } from "../src/runner-health";
import { createRemoteAgentRunner } from "../src/runner-backend";

test("unavailable placement names the saved agent and why no runner can take it", async () => {
  const db = tempDb();
  try {
    const queued = insertQueuedItem(db, { id: "unavailable-agent" });
    const { item, run } = beginImplementRun(db, queued.id, Date.now());
    const work = createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    });
    const backend = createRemoteAgentRunner({
      db,
      work,
      results: createRunnerResults({ db, work }),
      health: createRunnerHealth({ db, work }),
      fetchCandidate: async () => {
        throw new Error("Unavailable placement must not fetch a candidate");
      },
    });
    await expect(
      backend.forItem(item.id)({
        itemId: item.id,
        runId: run.id,
        role: "implementer",
        profile: { agent: "grok", model: "grok-4.7" },
        pawsRoot: "/unused",
        worktreePath: "/unused",
        prompt: "Continue",
      }),
    ).rejects.toThrow(
      "No available paired runner can access this Linear task repository with agent grok (no paired runners in the task workspace)",
    );
  } finally {
    db.close();
  }
});
