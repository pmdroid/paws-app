import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchGitHubClient, type GitExec } from "../github";
import {
  bindLinearSessionTask,
  getWorkItem,
  migrate,
  openDatabase,
  recordLinearInstallation,
} from "../db";
import { intakeDelegatedIssue } from "../intake";
import {
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
} from "../linear";
import { LinearTaskAccess } from "./linear-task-access";
import { guardGitHubPublication } from "./publication";

function fixture(gitExec?: GitExec, onCleanupFailure = () => {}) {
  const controller = new AbortController();
  const state = {
    current: true,
    tokens: 0,
    checks: 0,
    acquire: async () => "synthetic-token",
    verify: async () => {},
    respond: async (_init?: RequestInit) => Response.json({ ok: true }),
  };
  const requests: RequestInit[] = [];
  const guarded = guardGitHubPublication({
    repository: { owner: "owner", repo: "repo", remoteUrl: "https://github.com/owner/repo.git" },
    github: {
      appId: "unused",
      installationId: "unused",
      privateKeyPem: "unused",
      client: createFetchGitHubClient(async (_url, init) => {
        requests.push(init!);
        return state.respond(init);
      }),
      tokenProvider: {
        mode: "oauth",
        async tokenFor() {
          state.tokens++;
          return state.acquire();
        },
      },
    },
    signal: controller.signal,
    gitExec,
    onCleanupFailure,
    isCurrent: () => state.current,
    async assert() {
      state.checks++;
      await state.verify();
    },
  });
  return { controller, state, requests, guarded };
}

test.each(["push", "pr", "merge"] as const)(
  "human issue cancellation during the access read fences pending %s publication",
  async (purpose) => {
    const db = openDatabase(":memory:");
    migrate(db);
    let pushes = 0;
    const f = fixture(async () => {
      pushes++;
      return { stdout: "", stderr: "" };
    });
    const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-1",
        title: "Request",
        description: null,
        subIssues: [],
      },
    ]);
    try {
      const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue" });
      if (!task.ok) throw new Error("Unexpected dependency cycle");
      recordLinearInstallation(db, {
        ...scope,
        sessionId: "session",
        teamId: "team",
        observedAtMs: 1,
      });
      bindLinearSessionTask(db, "session", task.epic.id, { actorId: "human" });
      const access = createFakeLinearAccessReads({
        installation: scope,
        sessions: [{ ...scope, sessionId: "session", issueId: "issue", teamId: "team" }],
        teams: ["team"],
      });
      const lifecycle = createFakeLinearIssueLifecycle({
        id: "issue",
        teamId: "team",
        assigneeId: "human",
        delegateId: "app",
        stateType: "started",
      });
      const stopped: string[] = [];
      const gate = new LinearTaskAccess(db, {
        access: access.adapter,
        lifecycle,
        oauthClientId: "client",
        appUserId: "app",
        stopSession: (id) => {
          stopped.push(id);
        },
      });
      const item = getWorkItem(db, task.items[0]!.id)!;
      f.state.verify = () => gate.assert(item, f.controller.signal);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const read = access.adapter.session;
      access.adapter.session = async (...args) => {
        started.resolve();
        await release.promise;
        return read(...args);
      };
      const work =
        purpose === "push"
          ? f.guarded.gitExec(["push", "origin", "HEAD"], { cwd: "/unused", env: {} })
          : f.guarded.client.request({
              method: purpose === "pr" ? "POST" : "PUT",
              path: purpose === "pr" ? "/pulls" : "/pulls/1/merge",
              token: "synthetic-token",
            });
      await started.promise;
      lifecycle.issue.stateType = "canceled";
      release.resolve();
      await expect(work).rejects.toThrow("workflow");
      expect(stopped).toEqual(["session"]);
      expect(pushes).toBe(0);
      expect(f.requests).toEqual([]);
    } finally {
      f.controller.abort();
      db.close();
    }
  },
);

test.each(["push", "pr", "merge"] as const)(
  "a new generation fences %s token acquisition",
  async (purpose) => {
    const f = fixture();
    const token = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    f.state.acquire = () => {
      started.resolve();
      return token.promise;
    };
    const work = f.guarded.tokenProvider!.tokenFor(purpose);
    await started.promise;
    f.state.current = false;
    token.resolve("synthetic-token");
    await expect(work).rejects.toThrow("superseded");
    expect(f.requests).toEqual([]);
  },
);

test.each(["POST", "PATCH", "PUT"] as const)(
  "fresh access is checked before every %s mutation",
  async (method) => {
    const f = fixture();
    await f.guarded.client.request({ method, path: "/first", token: "synthetic-token" });
    f.state.verify = async () => {
      throw new Error("Linear delegation was removed");
    };
    await expect(
      f.guarded.client.request({ method, path: "/second", token: "synthetic-token" }),
    ).rejects.toThrow("delegation");
    expect(f.requests).toHaveLength(1);
    expect(f.state.checks).toBe(2);
  },
);

test("a generation change while verifying access prevents the mutation", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<void>();
  f.state.verify = async () => {
    started.resolve();
    await verified.promise;
  };
  const work = f.guarded.client.request({
    method: "POST",
    path: "/pulls",
    token: "synthetic-token",
  });
  await started.promise;
  f.state.current = false;
  verified.resolve();
  await expect(work).rejects.toThrow("superseded");
  expect(f.requests).toEqual([]);
});

test.skipIf(process.platform !== "linux")(
  "Stop joins the actual publication Git shell and descendant before returning",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-publication-stop-"));
    const script = join(root, "wait.js");
    const marker = join(root, "pid");
    const f = fixture();
    let pid = 0;
    try {
      writeFileSync(
        script,
        `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`,
      );
      const pending = f.guarded
        .gitExec(
          ["-c", `alias.paws-wait=!"${process.execPath}" "${script}"`, "paws-wait", marker],
          { cwd: root, env: process.env },
        )
        .catch((error: unknown) => error);
      for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(5);
      expect(existsSync(marker)).toBe(true);
      pid = Number(readFileSync(marker, "utf8"));
      f.controller.abort();
      expect(await pending).toMatchObject({ name: "AbortError" });
      const running = () => {
        try {
          return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
        } catch {
          return false;
        }
      };
      expect(running()).toBe(false);
    } finally {
      f.controller.abort();
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test.skipIf(process.platform !== "linux")(
  "lost publication Git ownership reports cleanup failure before returning",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-publication-owner-"));
    const script = join(root, "wait.js");
    const marker = join(root, "owner.json");
    let cleanupFailed = false;
    const f = fixture(undefined, () => {
      cleanupFailed = true;
    });
    let pid = 0;
    let pending: Promise<unknown> | undefined;
    try {
      writeFileSync(
        script,
        `const fs=require("node:fs"); process.on("SIGTERM", () => {}); let anchor=process.ppid; while(!fs.readFileSync("/proc/"+anchor+"/cmdline", "utf8").includes("process-anchor.ts")) { const stat=fs.readFileSync("/proc/"+anchor+"/stat", "utf8"); anchor=Number(stat.slice(stat.lastIndexOf(")")+2).split(" ")[1]); } fs.writeFileSync(process.argv[2], JSON.stringify({ pid:process.pid, anchor })); setInterval(() => {}, 1000);`,
      );
      pending = f.guarded
        .gitExec(
          ["-c", `alias.paws-wait=!"${process.execPath}" "${script}"`, "paws-wait", marker],
          { cwd: root, env: process.env },
        )
        .catch((error: unknown) => error);
      for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(5);
      expect(existsSync(marker)).toBe(true);
      const owner = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; anchor: number };
      pid = owner.pid;
      process.kill(owner.anchor, "SIGKILL");
      f.controller.abort();
      expect(await pending).toMatchObject({ message: "Git process cleanup could not be verified" });
      expect(cleanupFailed).toBe(true);
    } finally {
      f.controller.abort();
      await pending;
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test("removal after fetch prevents the actual Git push with an already acquired token", async () => {
  const commands: string[][] = [];
  const f = fixture(async (args) => {
    commands.push(args);
    return { stdout: "", stderr: "" };
  });
  await f.guarded.tokenProvider!.tokenFor("push");
  await f.guarded.gitExec(["fetch", "/local/remote"], { cwd: "/local/repo", env: {} });
  f.state.verify = async () => {
    throw new Error("Delegation removed during fetch");
  };
  await expect(
    f.guarded.gitExec(["push", "/local/remote", "HEAD"], { cwd: "/local/repo", env: {} }),
  ).rejects.toThrow("Delegation");
  expect(commands).toEqual([["fetch", "/local/remote"]]);
});

test("Stop aborts owned Git execution", async () => {
  const started = Promise.withResolvers<void>();
  const f = fixture(async (_args, options) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
        once: true,
      });
    });
  });
  const work = f.guarded.gitExec(["fetch", "/local/remote"], { cwd: "/local/repo", env: {} });
  await started.promise;
  f.controller.abort(new Error("Stopped owned Git execution"));
  await expect(work).rejects.toThrow("Stopped owned Git");
});

test("Stop aborts an owned GitHub request while preserving the caller signal", async () => {
  const f = fixture();
  const caller = new AbortController();
  const started = Promise.withResolvers<void>();
  f.state.respond = async (init) => {
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  const work = f.guarded.client.request({
    method: "GET",
    path: "/pulls/1",
    token: "synthetic-token",
    signal: caller.signal,
  });
  await started.promise;
  f.controller.abort(new Error("Stopped"));
  await expect(work).rejects.toThrow("Stopped");
  expect(caller.signal.aborted).toBe(false);
  expect(f.requests[0]?.signal?.aborted).toBe(true);
});

test("an observed successful merge remains truthful when Stop races its response", async () => {
  const f = fixture();
  f.state.respond = async () => {
    f.controller.abort();
    return Response.json({ merged: true, sha: "verified-merge" });
  };
  expect(
    await f.guarded.client.request({ method: "PUT", path: "/merge", token: "synthetic-token" }),
  ).toEqual({ status: 200, body: { merged: true, sha: "verified-merge" } });
  await expect(
    f.guarded.client.request({ method: "PATCH", path: "/after", token: "synthetic-token" }),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});
