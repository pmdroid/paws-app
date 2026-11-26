import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerRepositoryBundlePath } from "../runner-execution";
import type { RunnerCommand } from "../runner-protocol";
import { openRunnerHealthRuntime } from ".";

const TOKEN = "ghs_probeWriteSecret0123456789abcdef";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", env }).trim();

test.skipIf(process.getuid!() === 0)(
  "a probe_write helper's job carries a bundle of the repository's fetched origin/main only",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-probe-write-"));
    chmodSync(root, 0o700);
    mkdirSync(join(root, "spool"), { mode: 0o750 });
    chmodSync(join(root, "spool"), 0o750);
    mkdirSync(join(root, "results"), { mode: 0o770 });
    chmodSync(join(root, "results"), 0o770);
    const origin = join(root, "origin");
    mkdirSync(origin);
    git("-C", origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "README.md"), "web\n");
    git("-C", origin, "add", ".");
    const commit = ["-c", "user.name=Paws", "-c", "user.email=paws@example.com", "commit", "-qm"];
    git("-C", origin, ...commit, "init");
    const main = git("-C", origin, "rev-parse", "HEAD");
    git("-C", origin, "checkout", "-q", "-b", "other");
    git("-C", origin, ...commit, "other", "--allow-empty");
    const now = Date.now();
    const command: Extract<RunnerCommand, { type: "helper" }> = {
      id: randomUUID(),
      type: "helper",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 900_000,
      sessionId: "probes-write",
      sessionGeneration: 0,
      purpose: "probe_write",
      profile: { agent: "codex", model: null },
      prompt: "Write the probe.",
      account: { accountId: "account", bindingId: "binding" },
      probe: { repository: "acme/web", path: ".agents/probes/no-raw-sql.ts" },
    };
    const fetched: string[] = [];
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    const runtime = await openRunnerHealthRuntime({
      root,
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
        async helperProbeCredential(id) {
          expect(id).toBe(command.id);
          return {
            token: TOKEN,
            expiresAt: Date.now() + 600_000,
            remoteUrl: "https://github.com/acme/web.git",
            branch: null,
            repository: "acme/web",
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
        fetched.push(`${input.operation} ${input.remoteUrl} ${input.refspec}`);
        git("--git-dir", input.dest!, "fetch", "-q", origin, input.refspec!);
      },
      spool,
      results: {
        root: join(root, "results"),
        agentUid: process.getuid!(),
        resultsGid: process.getgid!(),
      },
      broker: {
        async start() {
          return { alreadyAdmitted: false };
        },
        async stop() {},
      },
    });
    try {
      await runtime.tick();
      const executionId = runtime.status().active!.executionId;
      expect(fetched).toEqual([
        "fetch https://github.com/acme/web.git +refs/heads/main:refs/heads/main",
      ]);
      const bundle = runnerRepositoryBundlePath(spool, executionId);
      expect(git("bundle", "list-heads", bundle)).toBe(`${main} refs/heads/main`);
      expect(readFileSync(bundle).includes(TOKEN)).toBe(false);
      expect(existsSync(join(root, "repositories", executionId))).toBe(false);
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
