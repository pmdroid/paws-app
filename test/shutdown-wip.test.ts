import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createWorktree, ensureBareMirror, git, worktreePath } from "../src/acp";
import {
  beginImplementRun,
  bindLinearSessionTask,
  enqueueJob,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  openDatabase,
  saveTaskMode,
} from "../src/db";
import { JOB_KIND } from "../src/core";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";

describe("shutdown WIP", () => {
  test("stop commits WIP on the item branch before the run is recoverable", async () => {
    const home = tempHome();
    await seedWorktree(home, "ENG-21");
    await writeFile(join(worktreePath(home, "ENG-21"), "notes.txt"), "dirty\n");
    const paws = startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
      PAWS_NO_TUNNEL: "1",
    });
    insertQueuedItem(paws.db, {
      id: "ENG-21",
      branchName: "paws/eng-21",
      now: Date.now(),
    });
    beginImplementRun(paws.db, "ENG-21", Date.now(), {
      phase: "running",
      wipCommit: "wip",
      turn: 1,
    });
    await paws.stop();

    expect(
      (await git(["-C", worktreePath(home, "ENG-21"), "log", "-1", "--format=%s"])).trim(),
    ).toBe("wip: shutdown");
    expect(
      (await git(["-C", worktreePath(home, "ENG-21"), "branch", "--show-current"])).trim(),
    ).toBe("paws/eng-21");
    const db = openDatabase(paws.paths.db);
    expect(getWorkItem(db, "ENG-21")?.state).toBe("recovering");
    db.close();
  }, 20_000);

  test("stop joins a live ACP descendant before WIP recovery and database closure", async () => {
    const home = tempHome();
    const evidence = join(home, "owned-agent.jsonl");
    await seedWorktree(home, "ENG-21");
    await writeFile(join(worktreePath(home, "ENG-21"), "notes.txt"), "dirty\n");
    await writeFile(join(home, "config.toml"), '[linear]\nmode = "agent-session"\n');
    const previous = process.env.PAWS_CLAUDE_ACP;
    process.env.PAWS_CLAUDE_ACP = [
      process.execPath,
      new URL("./fixtures/brief-agent.ts", import.meta.url).pathname,
      "implement",
      evidence,
      "implementer",
      "hang",
    ].join(" ");
    const paws = startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
      PAWS_NO_TUNNEL: "1",
    });
    try {
      const answer = insertQueuedItem(paws.db, { id: "answer", sessionKey: "session" });
      ensureLinearSession(paws.db, { sessionId: "session" });
      bindLinearSessionTask(paws.db, "session", answer.epicId);
      saveTaskMode(paws.db, answer.id, "answer");
      enqueueJob(paws.db, { queue: JOB_KIND.start, payload: { itemId: answer.id } });
      for (let i = 0; i < 5_000 && !existsSync(evidence + ".descendant"); i++) await Bun.sleep(1);
      expect(existsSync(evidence + ".descendant")).toBe(true);
      const descendant = Number(readFileSync(evidence + ".descendant", "utf8"));
      expect(processAlive(descendant)).toBe(true);
      insertQueuedItem(paws.db, { id: "ENG-21", branchName: "paws/eng-21" });
      beginImplementRun(paws.db, "ENG-21", Date.now(), { phase: "running", turn: 1 });
      const stopping = paws.stop();
      expect(paws.stop()).toBe(stopping);
      expect(getWorkItem(paws.db, answer.id)?.state).toBe("running");
      await stopping;
      expect(processAlive(descendant)).toBe(false);
      expect(() => getWorkItem(paws.db, answer.id)).toThrow();
      expect(
        (await git(["-C", worktreePath(home, "ENG-21"), "log", "-1", "--format=%s"])).trim(),
      ).toBe("wip: shutdown");
      const recovered = openDatabase(paws.paths.db);
      try {
        expect(getWorkItem(recovered, "ENG-21")?.state).toBe("recovering");
        expect(getWorkItem(recovered, answer.id)?.state).toBe("recovering");
      } finally {
        recovered.close();
      }
    } finally {
      await paws.stop();
      if (previous === undefined) delete process.env.PAWS_CLAUDE_ACP;
      else process.env.PAWS_CLAUDE_ACP = previous;
    }
  }, 15_000);

  test("SIGTERM commits the same WIP before exit", async () => {
    const home = tempHome();
    await seedWorktree(home, "ENG-21");
    await writeFile(join(worktreePath(home, "ENG-21"), "notes.txt"), "dirty\n");
    const env = childEnv(home);
    const proc = Bun.spawn(["bun", "src/index.ts", "--no-tunnel"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await readUntil(proc, "paws ready", 15_000);
      const db = openDatabase(join(home, "paws.db"));
      insertQueuedItem(db, {
        id: "ENG-21",
        branchName: "paws/eng-21",
        now: Date.now(),
      });
      beginImplementRun(db, "ENG-21", Date.now(), { phase: "running", turn: 1 });
      db.close();
      proc.kill("SIGTERM");
      const code = await Promise.race([
        proc.exited,
        new Promise<number>((_resolve, reject) => {
          setTimeout(() => reject(new Error("SIGTERM did not exit")), 15_000);
        }),
      ]);
      expect(code).toBe(0);
      expect(
        (await git(["-C", worktreePath(home, "ENG-21"), "log", "-1", "--format=%s"])).trim(),
      ).toBe("wip: shutdown");
      const after = openDatabase(join(home, "paws.db"));
      expect(getWorkItem(after, "ENG-21")?.state).toBe("recovering");
      after.close();
    } finally {
      proc.kill();
    }
  }, 30_000);
});

async function seedWorktree(home: string, itemId: string): Promise<void> {
  const source = join(home, "source");
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(["-C", source, "add", "README.md"]);
  await git([
    "-C",
    source,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "init",
  ]);
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot: home });
  await createWorktree({ owner: "acme", repo: "demo", itemId, pawsRoot: home });
}

function childEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
    PAWS_NO_TUNNEL: "1",
  };
  for (const key of [
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_REFRESH_TOKEN",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_WEBHOOK_SECRET",
    "NGROK_AUTHTOKEN",
    "PAWS_PUBLIC_URL",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_WEBHOOK_SECRET",
    "PAWS_GITHUB_REPOSITORY",
  ]) {
    delete env[key];
  }
  return env;
}

async function readUntil(proc: Bun.Subprocess, needle: string, timeoutMs: number): Promise<string> {
  const stdout = proc.stdout;
  if (stdout === undefined || typeof stdout === "number") {
    throw new Error("stdout was not piped");
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const stderr = proc.stderr;
      let err = "";
      if (stderr !== undefined && typeof stderr !== "number") {
        err = new TextDecoder().decode(await new Response(stderr).arrayBuffer());
      }
      throw new Error(`timed out waiting for ${needle}: ${text}\n${err}`);
    }
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timed out waiting for ${needle}: ${text}`)), remaining);
      }),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}

function processAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
