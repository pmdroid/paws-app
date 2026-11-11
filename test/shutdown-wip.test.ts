import { and, eq, gt } from "drizzle-orm";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createWorktree, ensureBareMirror, git, worktreePath } from "../src/acp";
import {
  beginImplementRun,
  saveRunCommitPolicy,
  bindLinearSessionTask,
  enqueueJob,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  saveTaskMode,
} from "../src/db";
import { JOB_KIND } from "../src/core";
import { startPaws } from "../src/index";
import { tempHome, storeHomeLinearToken, withHomeStore } from "./helpers";
import { pgliteServer } from "./pglite";

/** App mode commits WIP only under a run commit policy. */
const APP_POLICY = {
  bot: { appId: "1", login: "paws-test[bot]", id: 1 },
  credit: null,
};

describe("shutdown WIP", () => {
  test("stop commits WIP on the item branch before the run is recoverable", async () => {
    const home = tempHome();
    await seedWorktree(home, "ENG-21");
    await writeFile(join(worktreePath(home, "ENG-21"), "notes.txt"), "dirty\n");
    const paws = await startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
    });
    await insertQueuedItem(paws.store, {
      id: "ENG-21",
      branchName: "paws/eng-21",
      now: Date.now(),
    });
    await saveRunCommitPolicy(
      paws.store,
      (
        await beginImplementRun(paws.store, "ENG-21", Date.now(), {
          phase: "running",
          wipCommit: "wip",
          turn: 1,
        })
      ).run.id,
      APP_POLICY,
    );
    await paws.stop();

    expect(
      (await git(["-C", worktreePath(home, "ENG-21"), "log", "-1", "--format=%s"])).trim(),
    ).toBe("wip: shutdown");
    expect(
      (await git(["-C", worktreePath(home, "ENG-21"), "branch", "--show-current"])).trim(),
    ).toBe("paws/eng-21");
    expect((await withHomeStore(home, (store) => getWorkItem(store, "ENG-21")))?.state).toBe(
      "recovering",
    );
  }, 20_000);

  test("without a Linear workspace a start job launches nothing and stop still commits recoverable WIP", async () => {
    const home = tempHome();
    const evidence = join(home, "owned-agent.jsonl");
    await seedWorktree(home, "ENG-21");
    await writeFile(join(worktreePath(home, "ENG-21"), "notes.txt"), "dirty\n");
    await writeFile(join(home, "config.toml"), "[linear]\n");
    const previous = process.env.PAWS_CLAUDE_ACP;
    process.env.PAWS_CLAUDE_ACP = [
      process.execPath,
      new URL("./fixtures/brief-agent.ts", import.meta.url).pathname,
      "implement",
      evidence,
      "implementer",
      "hang",
    ].join(" ");
    await storeHomeLinearToken(home, {
      accessToken: "synthetic-linear-token",
      refreshToken: "synthetic-refresh-token",
      expiresAtMs: Date.now() + 600_000,
      actor: "app",
      scope: "read,write",
    });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        const { query, variables } = JSON.parse(String(init?.body));
        if (query.includes("PawsSessionInstallation"))
          return Response.json({
            data: {
              viewer: { id: "app", app: true, organization: { id: "org" } },
              agentSession: {
                id: "session",
                appUser: { id: "app", app: true, organization: { id: "org" } },
                issue: { id: "lin-item-answer", team: { id: "team" } },
              },
            },
          });
        if (query.includes("IssueOwnership"))
          return Response.json({
            data: {
              issue: {
                id: "lin-item-answer",
                team: { id: "team" },
                state: { type: "started" },
                assignee: { id: "human" },
                delegate: { id: "app" },
              },
            },
          });
        if (query.includes("PawsTeamAccess"))
          return Response.json({ data: { team: { id: "team" } } });
        if (query.includes("PawsAgentSessionHistory"))
          return Response.json({
            data: {
              agentSession: {
                id: "session",
                activities: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          });
        if (query.includes("PawsAgentSession"))
          return Response.json({
            data: {
              agentSession: {
                id: "session",
                status: "active",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                appUser: { id: "app" },
                creator: { id: "human" },
                issue: {
                  id: "lin-item-answer",
                  identifier: "answer",
                  title: "Answer",
                  description: null,
                },
                externalLinks: [],
              },
            },
          });
        if (query.includes("agentActivityCreate"))
          return Response.json({
            data: {
              agentActivityCreate: { success: true, agentActivity: { id: variables.input.id } },
            },
          });
        if (query.includes("agentSessionUpdate"))
          return Response.json({
            data: { agentSessionUpdate: { success: true, agentSession: { id: "session" } } },
          });
        if (query.includes("agentSessions") || query.includes("issues"))
          return Response.json({
            data: {
              agentSessions: { nodes: [], pageInfo: { hasNextPage: false } },
              issues: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          });
        throw new Error("Unexpected offline Linear request");
      },
      { preconnect: () => undefined },
    );
    const paws = await startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
      LINEAR_CLIENT_ID: "client",
      LINEAR_CLIENT_SECRET: "synthetic-client-secret",
      LINEAR_APP_USER_ID: "app",
      LINEAR_TEAM_ID: "team",
    });
    try {
      const answer = await insertQueuedItem(paws.store, { id: "answer", sessionKey: "session" });
      await ensureLinearSession(paws.store, {
        sessionId: "session",
        issueId: answer.linearIssueId,
        creatorId: "human",
      });
      await bindLinearSessionTask(paws.store, "session", answer.delegationId);
      await saveTaskMode(paws.store, answer.id, "answer");
      await enqueueJob(paws.store, {
        queue: JOB_KIND.start,
        payload: { itemId: answer.id },
      });
      const ticked = async () =>
        (
          await paws.store.run((q) =>
            q.all(
              q.orm
                .select({ id: q.t.job.id })
                .from(q.t.job)
                .where(
                  and(eq(q.t.job.queue, "scheduler.tick"), gt(q.t.job.runAt, q.t.job.createdAt)),
                ),
            ),
          )
        ).length > 0;
      for (let i = 0; i < 2_000 && !(await ticked()); i += 5) await Bun.sleep(5);
      expect(await ticked()).toBe(true);
      expect((await getWorkItem(paws.store, answer.id))?.state).toBe("queued");
      expect(existsSync(evidence)).toBe(false);
      expect(existsSync(`${evidence}.descendant`)).toBe(false);
      await insertQueuedItem(paws.store, { id: "ENG-21", branchName: "paws/eng-21" });
      await saveRunCommitPolicy(
        paws.store,
        (
          await beginImplementRun(paws.store, "ENG-21", Date.now(), {
            phase: "running",
            turn: 1,
          })
        ).run.id,
        APP_POLICY,
      );
      const stopping = paws.stop();
      expect(paws.stop()).toBe(stopping);
      await stopping;
      await expect(getWorkItem(paws.store, answer.id)).rejects.toThrow();
      expect(
        (await git(["-C", worktreePath(home, "ENG-21"), "log", "-1", "--format=%s"])).trim(),
      ).toBe("wip: shutdown");
      await withHomeStore(home, async (store) => {
        expect((await getWorkItem(store, "ENG-21"))?.state).toBe("recovering");
        expect((await getWorkItem(store, answer.id))?.state).toBe("queued");
      });
    } finally {
      await paws.stop();
      globalThis.fetch = nativeFetch;
      if (previous === undefined) delete process.env.PAWS_CLAUDE_ACP;
      else process.env.PAWS_CLAUDE_ACP = previous;
    }
  }, 15_000);

  test("SIGTERM commits the same WIP before exit", async () => {
    const home = tempHome();
    await seedWorktree(home, "ENG-21");
    await writeFile(join(worktreePath(home, "ENG-21"), "notes.txt"), "dirty\n");
    const server = await pgliteServer();
    const env = { ...childEnv(home), PAWS_DATABASE_URL: server.url };
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await readUntil(proc, "paws ready", 15_000);
      const db = server.store;
      await insertQueuedItem(db, {
        id: "ENG-21",
        branchName: "paws/eng-21",
        now: Date.now(),
      });
      await saveRunCommitPolicy(
        db,
        (await beginImplementRun(db, "ENG-21", Date.now(), { phase: "running", turn: 1 })).run.id,
        APP_POLICY,
      );
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
      expect((await getWorkItem(db, "ENG-21"))?.state).toBe("recovering");
    } finally {
      proc.kill();
      await server.close();
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
  };
  for (const key of [
    "PAWS_EXECUTION",
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_REFRESH_TOKEN",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_WEBHOOK_SECRET",
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
