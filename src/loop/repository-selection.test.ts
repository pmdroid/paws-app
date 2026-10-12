import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConversation, insertQueuedItem, migrate, openDatabase, saveConversation } from "../db";
import { tmpdir } from "node:os";
import { interpretRepositoryAnswer } from "./repository-selection";

test("lost repository interpreter ownership persists cleanup failure before aborted reply handling", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-selector-cleanup-"));
  const databasePath = join(home, "cleanup.db");
  let db = openDatabase(databasePath);
  migrate(db);
  const marker = join(home, "owner.json");
  const trace = join(home, "trace.json");
  const script = join(home, "script.json");
  const wrapper = join(home, "fake-agent.ts");
  const controller = new AbortController();
  let pid = 0;
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  writeFileSync(script, JSON.stringify({ steps: [{ type: "hang" }] }));
  writeFileSync(
    wrapper,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, anchor: process.ppid })); await import(${JSON.stringify(resolve(import.meta.dir, "../acp/testing/fake-agent.ts"))});`,
  );
  const repository = { owner: "acme", repo: "app", remoteUrl: "local" };
  const pending = interpretRepositoryAnswer({
    answer: "Use app, not other.",
    candidates: [repository],
    offered: [repository],
    itemId: "item",
    pawsRoot: home,
    home,
    profile: { agent: "codex", model: null },
    signal: controller.signal,
    launch: () => ({ command: process.execPath, args: [wrapper, trace, script], env: process.env }),
    onCleanupFailure() {
      saveConversation(db, "item", "[]", null, true);
    },
  }).catch((error: unknown) => error);
  try {
    let prompts: unknown[] | undefined;
    for (let i = 0; i < 300; i++) {
      try {
        const saved = JSON.parse(readFileSync(trace, "utf8"));
        if (Array.isArray(saved.prompts) && saved.prompts.length) {
          prompts = saved.prompts;
          break;
        }
      } catch {}
      await Bun.sleep(5);
    }
    expect(prompts).toHaveLength(1);
    const owner = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; anchor: number };
    pid = owner.pid;
    expect(owner.anchor).toBeGreaterThan(0);
    process.kill(owner.anchor, "SIGKILL");
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(getConversation(db, "item").blocked).toBe(true);
    db.close();
    db = openDatabase(databasePath);
    expect(getConversation(db, "item").blocked).toBe(true);
  } finally {
    controller.abort();
    await pending;
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
