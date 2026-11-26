import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readRunnerAnswer } from "../runner-answers";
import { RunnerRequestError } from "../runner-daemon";
import { createRunnerResultDirectory, runnerHelperRepositories } from "../runner-execution";
import type { RunnerCommand } from "../runner-protocol";
import { openRunnerHealthRuntime } from ".";

const TOKEN = "ghs_helperRepositorySecret0123456789";

function repository(root: string, name: string) {
  const path = join(root, "origin", name);
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), `${name}\n`);
  git("add", ".");
  git("-c", "user.name=Paws", "-c", "user.email=paws@example.com", "commit", "-qm", "init");
  return { path, commit: git("rev-parse", "HEAD") };
}

function walk(path: string): string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => walk(join(path, name)))
    : [readFileSync(path, "utf8")];
}

test.skipIf(process.getuid!() === 0)(
  "a Slack reply helper prepares listed repositories and answers add requests",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-helper-repositories-"));
    chmodSync(root, 0o700);
    mkdirSync(join(root, "spool"), { mode: 0o750 });
    chmodSync(join(root, "spool"), 0o750);
    mkdirSync(join(root, "results"), { mode: 0o770 });
    chmodSync(join(root, "results"), 0o770);
    const origins = {
      "acme/app": repository(root, "app"),
      "acme/lib": repository(root, "lib"),
    } as Record<string, { path: string; commit: string }>;
    const now = Date.now();
    const command: Extract<RunnerCommand, { type: "helper" }> = {
      id: randomUUID(),
      type: "helper",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 180_000,
      sessionId: "slack-1",
      sessionGeneration: 1,
      purpose: "slack_reply",
      profile: { agent: "claude", model: null },
      prompt: "How does checkout round totals?",
      slack: {
        requestId: "slack-1",
        teamId: "T0ACME",
        channelId: "C0GENERAL",
        threadTs: "1795053091.151000",
        memberUserId: "member",
        installGeneration: 1,
      },
      repositories: ["acme/app", "acme/refused"],
    };
    const credentials: string[] = [];
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    const results = {
      root: join(root, "results"),
      agentUid: process.getuid!(),
      resultsGid: process.getgid!(),
    };
    const runtime = await openRunnerHealthRuntime({
      root,
      conversations: () => 1,
      daemon: {
        status: () => ({
          phase: "paired",
          runnerId: "runner",
          workspaceId: "workspace",
          fingerprint: "fixture",
          expiresAt: now + 3_600_000,
        }),
        pendingCommands: () => [command],
        async pollCommands() {
          return { commands: [], rejected: [], deniedRepositories: [] };
        },
        async pollHelperCommands() {
          return { commands: [command], rejected: [], deniedRepositories: [] };
        },
        async helperLease() {
          return { expiresAt: command.expiresAt };
        },
        async helperRepositoryCredential(_id, name) {
          credentials.push(name);
          if (name === "acme/refused") throw new RunnerRequestError(403);
          return {
            token: TOKEN,
            expiresAt: Date.now() + 600_000,
            remoteUrl: `https://github.com/${name}.git`,
            branch: null,
            commit: origins[name]?.commit ?? "a".repeat(40),
          };
        },
        async acknowledgeCommand() {},
        async postHelperResult() {
          return { duplicate: false };
        },
        async postHealth() {
          throw new Error("Helpers do not post health");
        },
        async heartbeat() {
          throw new Error("Helpers do not use run heartbeats");
        },
      },
      async networkGit(input) {
        expect(input.token).toBe(TOKEN);
        const origin = origins[input.remoteUrl.slice(19, -4)];
        if (!origin) throw new Error(`clone of https://x:${input.token}@github.com failed`);
        execFileSync("git", ["clone", "-q", "--bare", origin.path, input.dest!]);
      },
      spool,
      results,
      broker: {
        async start() {
          return { alreadyAdmitted: false };
        },
        async stop() {},
      },
    });
    try {
      await runtime.tick();
      const executionId = runtime.status().conversations[0]!.executionId;
      const app = runnerHelperRepositories(spool, executionId);
      expect(app).toEqual([
        { repository: "acme/app", commit: origins["acme/app"]!.commit, path: expect.any(String) },
      ]);
      expect(readFileSync(join(app[0]!.path, "README.md"), "utf8")).toBe("app\n");

      const events = join(createRunnerResultDirectory(results, executionId), "events.jsonl");
      writeFileSync(events, "", { mode: 0o640 });
      chmodSync(events, 0o640);
      const ask = async (name: string) => {
        const requestId = randomUUID();
        appendFileSync(
          events,
          `${JSON.stringify({ type: "repository", requestId, repository: name, t: new Date().toISOString() })}\n`,
        );
        for (let waited = 0; waited < 10_000; waited += 50) {
          const published = readRunnerAnswer(spool, executionId, requestId);
          if (published) return JSON.parse(published.answer) as Record<string, string>;
          await delay(50);
        }
        throw new Error("No answer");
      };
      expect(await ask("acme/lib")).toEqual({
        path: join(
          spool.root,
          executionId,
          "repositories",
          "acme",
          "lib",
          origins["acme/lib"]!.commit,
        ),
        commit: origins["acme/lib"]!.commit,
      });
      expect(await ask("acme/refused")).toEqual({ error: "Paws could not add acme/refused." });
      expect(await ask("acme/missing")).toEqual({ error: "Paws could not add acme/missing." });
      expect(await ask("acme/fifth")).toEqual({ error: "Paws could not add acme/fifth." });
      expect(await ask("acme/sixth")).toEqual({ error: "Paws could not add acme/sixth." });
      expect(await ask("acme/app")).toMatchObject({ commit: origins["acme/app"]!.commit });
      expect(credentials).toEqual([
        "acme/app",
        "acme/refused",
        "acme/lib",
        "acme/refused",
        "acme/missing",
        "acme/fifth",
      ]);
      for (const text of walk(spool.root)) expect(text).not.toContain(TOKEN);
      expect(readdirSync(join(root, "repositories", executionId, "acme"))).toEqual([]);
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
