import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunAgentOptions } from "../../src/acp";
import { systemClock } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getRun,
  getWorkItem,
  listWorkItems,
  migrate,
  openDatabase,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import { attachOrchestrator } from "../../src/loop";

export async function probeRunnerOrchestration(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, err);
    return out.trim();
  }
  await git(["init", "-b", "main", source]);
  mkdirSync(join(source, ".agents/skills/review"), { recursive: true });
  writeFileSync(join(source, "README.md"), "Fixture\n");
  writeFileSync(
    join(source, ".agents/skills/review/SKILL.md"),
    "Review the candidate and return findings.\n",
  );
  writeFileSync(
    join(source, ".agents/closeout.yaml"),
    JSON.stringify({
      specVersion: "0.1",
      setup: [{ id: "prepare", exec: ["/forbidden-local-check", "setup"], timeoutSeconds: 5 }],
      items: [
        {
          id: "check",
          kind: "command",
          gate: "beforePR",
          exec: ["/forbidden-local-check", "check"],
          timeoutSeconds: 5,
        },
        {
          id: "review",
          kind: "review",
          gate: "beforePR",
          skill: ".agents/skills/review/SKILL.md",
          independence: { differentSession: true, differentModel: true },
          failOn: "P1",
        },
      ],
    }),
  );
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Fixture policy"]);
  await git(["clone", "--bare", source, origin]);
  for (const unavailable of [false, true]) {
    const home = join(root, unavailable ? "unavailable" : "available");
    mkdirSync(home, { mode: 0o700 });
    const db = openDatabase(join(home, "paws.db"));
    migrate(db);
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-42",
        title: "Write output",
        description: null,
        subIssues: [],
      },
    ]);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const calls: { role: string; prepare: boolean; prompt: string }[] = [];
    const checks: { argv: string[]; active: boolean }[] = [];
    let commandCount = 0;
    let implementationCount = 0;
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: home,
      home,
      tracker,
      repository: { owner: "acme", repo: "fixture", remoteUrl: origin },
      launch() {
        return { command: "/forbidden-local-agent", args: [] };
      },
      remoteExecution: {
        agentForSession() {
          throw new Error("This fixture does not request a routing helper");
        },
        agentForItem(itemId) {
          return async (options: RunAgentOptions) => {
            const item = getWorkItem(db, itemId)!;
            assert.equal(getRun(db, item.currentRunId!)?.status, "active");
            calls.push({
              role: options.role,
              prepare: !!options.prepareOnly,
              prompt: options.prompt,
            });
            if (unavailable) throw new Error("fixture remote transport unavailable");
            const script = join(home, `agent-${calls.length}.json`);
            const reviewer = options.role === "reviewer";
            if (!reviewer && !options.prepareOnly) implementationCount++;
            writeFileSync(
              script,
              JSON.stringify({
                sessionId: `session-${calls.length}`,
                model: reviewer ? "fixture-review-model" : "fixture-implement-model",
                steps: reviewer
                  ? [
                      {
                        type: "update",
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "[]" },
                        },
                      },
                      { type: "end" },
                    ]
                  : [
                      {
                        type: "fs_write",
                        path: join(options.worktreePath, "result.txt"),
                        content: implementationCount === 1 ? "initial\n" : "fixed\n",
                      },
                      {
                        type: "update",
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "PUBLIC_REMOTE_RESPONSE" },
                        },
                      },
                      { type: "end" },
                    ],
              }),
            );
            return runAgent({
              ...options,
              command: process.execPath,
              args: [join(import.meta.dir, "../../src/acp/testing/fake-agent.ts"), "", script],
              env: { PATH: process.env.PATH!, HOME: home },
            });
          };
        },
        closeoutForItem(itemId) {
          return {
            async runLogged(request) {
              const item = getWorkItem(db, itemId)!;
              const active = getRun(db, item.currentRunId!)?.status === "active";
              assert.equal(active, true);
              assert.equal(
                await git(["-C", request.cwd, "rev-parse", "HEAD"]),
                request.expectedHead,
              );
              checks.push({ argv: request.argv, active });
              if (request.argv[1] === "check") commandCount++;
              const bytes = Buffer.from("Recorded remote execution\n");
              mkdirSync(join(request.logFile, ".."), { recursive: true });
              writeFileSync(request.logFile, bytes, { mode: 0o600, flag: "wx" });
              return {
                argv: request.argv,
                exitCode: request.argv[1] === "check" && commandCount === 1 ? 1 : 0,
                timedOut: false,
                dirty: false,
                headMoved: false,
                durationMs: 1,
                truncated: false,
                artifacts: [
                  {
                    path: request.artifactPath,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                  },
                ],
              };
            },
          };
        },
      },
    });
    try {
      await orchestrator.onLinearEvent({
        dedupeKey: "created:issue",
        deliveryId: null,
        source: "webhook",
        action: "created",
        sessionId: "session",
        issueId: "issue",
        activityId: null,
        actorId: null,
        body: null,
        signal: null,
        updatedAtMs: Date.now(),
        payload: "{}",
      });
      await jobs.tick();
      const item = listWorkItems(db)[0]!;
      if (unavailable) {
        assert.equal(item.state, "awaiting_input", JSON.stringify(item));
        assert.equal(calls.length, 1);
        assert.equal(checks.length, 0);
      } else {
        assert.equal(item.state, "merge_queue", JSON.stringify(item));
        assert.equal(implementationCount, 2);
        assert(calls.filter((call) => call.prepare).length === 2);
        assert(calls.some((call) => call.role === "reviewer" && !call.prepare));
        const fix = calls.filter((call) => call.role === "implementer" && !call.prepare)[1]!;
        assert(fix.prompt.includes("PUBLIC_REMOTE_RESPONSE"));
        assert(fix.prompt.includes("Write output"));
        assert(checks.length >= 3);
      }
      assert.equal(getRun(db, item.currentRunId!)?.status, "ended");
      assert.equal(existsSync(join(home, "local-agent")), false);
      observe(
        unavailable
          ? "unavailable remote preparation blocks without local fallback"
          : "Linear orchestration routes preparation, implementation, fixes, reviews and commands through selected execution ports",
        true,
        {
          state: item.state,
          agentCalls: calls.map(({ role, prepare }) => ({ role, prepare })),
          commandCalls: checks,
          transport: "recording port with real scripted ACP, Git and SQLite",
        },
      );
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  }
}
