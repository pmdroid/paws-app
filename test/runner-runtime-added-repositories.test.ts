import { expect, test } from "bun:test";
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRunnerAnswer } from "../src/runner-answers";
import type { RunnerEventDelivery } from "../src/runner-daemon";
import { runnerHelperRepositories } from "../src/runner-execution";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand } from "../src/runner-protocol";

const TOKEN = "ghs_addedRepositorySecret0123456789";

function git(args: string[], cwd: string) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Acme",
      GIT_AUTHOR_EMAIL: "acme@example.invalid",
      GIT_COMMITTER_NAME: "Acme",
      GIT_COMMITTER_EMAIL: "acme@example.invalid",
    },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

function origin(root: string, name: string) {
  const source = join(root, "source", name);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "README.md"), `${name}\n`);
  git(["add", "."], source);
  git(["commit", "-q", "-m", "base"], source);
  const bare = join(root, "origins", `${name}.git`);
  git(["clone", "-q", "--bare", source, bare], root);
  return { bare, commit: git(["rev-parse", "HEAD"], source) };
}

function walk(path: string): string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => walk(join(path, name)))
    : [readFileSync(path, "latin1")];
}

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a run's repository requests are answered on the runner and never reach Paws",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-runtime-added-"));
    const now = Date.now();
    const origins: Record<string, { bare: string; commit: string }> = {
      "acme/widgets": origin(root, "widgets"),
      "acme/lib": origin(root, "lib"),
    };
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
    for (const directory of [spool.root, results.root]) {
      mkdirSync(directory);
      chmodSync(directory, directory === results.root ? 0o770 : 0o750);
    }
    const command: RunnerCommand = {
      id: "command",
      type: "run",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
      itemId: "item",
      generation: 1,
      issuedAt: now,
      expiresAt: now + 3_600_000,
      repository: {
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
        baseSha: origins["acme/widgets"]!.commit,
      },
      profile: { agent: "claude", model: null },
      prompt: "Implement the assigned issue",
      addRepositories: true,
    };
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "acme",
      expiresAt: now + 3_600_000,
    };
    let pending: RunnerCommand[] = [command];
    let execution = "";
    const asked: string[] = [];
    const sent: RunnerEventDelivery[] = [];
    const runtime = await openRunnerRuntime({
      root,
      spool,
      results,
      repositoryRoot: join(root, "repositories"),
      home: root,
      onError: () => {},
      async networkGit(request) {
        const name = request.remoteUrl.slice(19, -4);
        if (name !== "acme/widgets") expect(request.token).toBe(TOKEN);
        if (request.operation === "clone")
          git(["clone", "-q", "--bare", origins[name]!.bare, request.dest!], request.cwd);
        else if (request.operation === "fetch")
          git(["fetch", "-q", origins[name]!.bare, "+refs/heads/*:refs/heads/*"], request.dest!);
      },
      broker: {
        async start(id) {
          execution = id;
          const directory = join(results.root, id);
          mkdirSync(directory);
          chmodSync(directory, 0o750);
          writeFileSync(join(directory, "events.jsonl"), "");
          chmodSync(join(directory, "events.jsonl"), 0o640);
          return { alreadyAdmitted: false };
        },
        async stop() {},
        alive: () => true,
      },
      daemon: {
        status: () => paired,
        async heartbeat() {
          return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
        },
        async pollCommands() {
          return { commands: pending, rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => pending,
        async acknowledgeCommand(id) {
          pending = pending.filter((entry) => entry.id !== id);
        },
        async issueRunGrant() {
          return { token: "grant", expiresAt: now + 60_000 };
        },
        async sendEvent(delivery) {
          sent.push(delivery);
          return { duplicate: false };
        },
        async answers() {
          return { answers: [] };
        },
        async postResult() {
          return { duplicate: false };
        },
        async repositoryCredential(_runId, _generation, access, _token, repository) {
          if (repository === undefined)
            return {
              token: "ghs_task",
              expiresAt: Date.now() + 600_000,
              remoteUrl: "https://github.com/acme/widgets.git",
              branch: null,
            };
          asked.push(repository);
          expect(access).toBe("read");
          if (repository === "acme/refused") throw new Error("Paws refused acme/refused");
          return {
            token: TOKEN,
            expiresAt: Date.now() + 600_000,
            remoteUrl: `https://github.com/${repository}.git`,
            branch: null,
            commit: origins[repository]?.commit ?? "a".repeat(40),
          };
        },
        async renewCertificate() {
          return paired;
        },
        async uploadArtifact() {
          return { ok: true };
        },
        async uploadTranscript(_runId, chunk) {
          return { offset: chunk.offset, duplicate: false };
        },
        async finishTranscript() {
          return { uri: "transcript" };
        },
      },
    });
    try {
      for (let waited = 0; !execution; waited += 5) {
        if (waited > 10_000) throw new Error("The run did not start");
        await runtime.tick();
        await Bun.sleep(5);
      }
      const events = join(results.root, execution, "events.jsonl");
      const ask = async (name: string) => {
        const requestId = randomUUID();
        appendFileSync(
          events,
          `${JSON.stringify({ type: "repository", requestId, repository: name, t: new Date().toISOString() })}\n`,
        );
        for (let waited = 0; waited < 10_000; waited += 10) {
          await runtime.tick();
          const published = readRunnerAnswer(spool, execution, requestId);
          if (published) return JSON.parse(published.answer) as Record<string, string>;
          await Bun.sleep(10);
        }
        throw new Error("No answer");
      };
      const lib = origins["acme/lib"]!.commit;
      expect(await ask("acme/lib")).toEqual({
        path: join(spool.root, execution, "repositories", "acme", "lib", lib),
        commit: lib,
      });
      expect(
        readFileSync(
          join(spool.root, execution, "repositories/acme/lib", lib, "README.md"),
          "utf8",
        ),
      ).toBe("lib\n");
      expect(await ask("acme/refused")).toEqual({ error: "Paws could not add acme/refused." });
      for (const name of ["acme/three", "acme/four", "acme/five"])
        expect(await ask(name)).toEqual({ error: `Paws could not add ${name}.` });
      expect(await ask("acme/sixth")).toEqual({ error: "Paws could not add acme/sixth." });
      expect(await ask("acme/lib")).toMatchObject({ commit: lib });
      expect(asked).toEqual(["acme/lib", "acme/refused", "acme/three", "acme/four", "acme/five"]);
      expect(runnerHelperRepositories(spool, execution).map((added) => added.repository)).toEqual([
        "acme/lib",
      ]);
      expect(sent.filter((delivery) => delivery.event.type === "repository")).toEqual([]);
      for (const text of walk(spool.root)) expect(text).not.toContain(TOKEN);
      expect(
        readdirSync(join(root, "repositories")).filter((name) => name.startsWith("added-")),
      ).toEqual([]);
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
