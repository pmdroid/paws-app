import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCloseoutSession, type LoggedCommandRequest } from "../src/closeout-spec";
import {
  createCloseoutGate,
  loggedSessionCloseout,
  readSessionCloseout,
  sessionCloseoutResult,
  trustedPolicyFiles,
  writeSessionCloseout,
} from "../src/closeout";

const argv = [process.execPath, "-e", "await Bun.sleep(1500)"];

function policy(timeoutSeconds: number): string {
  return JSON.stringify({
    specVersion: "0.1",
    items: [{ id: "slow", kind: "command", gate: "beforePR", exec: argv, timeoutSeconds }],
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function commit(dir: string, message: string): string {
  git(dir, "add", ".");
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

test("a saved command result from a looser trusted timeout is run again under the tightened one", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-timeout-policy-"));
  try {
    const source = join(root, "source");
    const upstream = join(root, "upstream");
    const origin = join(root, "origin.git");
    git(root, "init", "-b", "main", source);
    mkdirSync(join(source, ".agents"));
    writeFileSync(join(source, ".agents/closeout.yaml"), policy(5));
    writeFileSync(join(source, "result.txt"), "base\n");
    const base = commit(source, "Base policy");
    git(root, "clone", "--bare", source, origin);
    git(source, "remote", "add", "origin", origin);
    writeFileSync(join(source, "result.txt"), "candidate\n");
    const head = commit(source, "Candidate");

    const sessionPath = join(root, "closeout-session.json");
    const refreshReport = async () => {
      const session = createCloseoutSession(source, {
        policy: async () => trustedPolicyFiles(source, root),
      });
      expect(await session.run("slow")).toStartWith("slow");
      writeSessionCloseout(sessionPath, head, await session.report());
    };
    await refreshReport();

    let refreshes = 0;
    const savedRunner = {
      async runLogged(request: LoggedCommandRequest) {
        if (!sessionCloseoutResult(readSessionCloseout(sessionPath)?.report, request)) {
          refreshes += 1;
          await refreshReport();
        }
        return loggedSessionCloseout(readSessionCloseout(sessionPath)?.report, request);
      },
    };
    const evaluate = (name: string, commandRunner?: typeof savedRunner) =>
      createCloseoutGate({
        candidate: { session: "candidate", model: "candidate-model", provider: "fixture" },
        reviewer: {
          async review() {
            throw new Error("Unexpected review");
          },
        },
        fixer: {
          async applyFix() {
            throw new Error("Unexpected fix");
          },
        },
        home: root,
        maxFixAttempts: 0,
        pawsHome: join(root, name),
        ...(commandRunner ? { commandRunner } : {}),
      }).run({ taskId: name, worktree: source, baseSha: base, headSha: head, attempt: 1 });

    const unchanged = await evaluate("unchanged", savedRunner);
    expect(unchanged.decision, unchanged.summary).toBe("accepted");
    expect(refreshes).toBe(0);

    git(root, "clone", origin, upstream);
    writeFileSync(join(upstream, ".agents/closeout.yaml"), policy(1));
    commit(upstream, "Tighten timeout");
    git(upstream, "push", "origin", "main");
    expect(git(source, "rev-parse", "HEAD")).toBe(head);

    const saved = await evaluate("saved", savedRunner);
    const fresh = await evaluate("fresh");
    expect(refreshes).toBe(1);
    expect(fresh.decision, fresh.summary).toBe("rejected");
    expect(saved.decision, saved.summary).toBe(fresh.decision);
    for (const verdict of [saved, fresh]) {
      const item = verdict.result?.decision?.items.find((entry) => entry.id === "slow");
      expect(item?.message).toBe("command timed out");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
