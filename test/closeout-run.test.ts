import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import type {
  CommandRecord,
  EvidenceRecord,
  EvidenceStore,
  ResolvedCommand,
  ResolvedPolicyPresent,
  ResolvedSetup,
  RetryPolicy,
} from "../src/closeout-spec";
import {
  PAWS_CLOSEOUT_PRODUCER,
  matchPaths,
  runCloseoutCommands,
  type CloseoutRunResult,
} from "../src/closeout-spec/run";

const exec = promisify(execFile);
const DIGEST = `sha256:${"ab".repeat(32)}`;

describe("matchPaths", () => {
  test("prefixes and globs follow the closeout path rules", () => {
    expect(matchPaths(["apps/engine/**"], ["apps/engine/main.ts"])).toBe(true);
    expect(matchPaths(["apps/engine/**"], ["apps/engine/src/main.ts"])).toBe(true);
    expect(matchPaths(["apps/engine/**"], ["apps/engine"])).toBe(true);
    expect(matchPaths(["apps/engine/**"], ["apps/frontend/main.ts"])).toBe(false);
    expect(matchPaths(["apps/engine/**"], ["apps/engine-extra/main.ts"])).toBe(false);
    expect(matchPaths(["apps/engine/"], ["apps/engine/main.ts"])).toBe(true);
    expect(matchPaths(["apps/engine/"], ["apps/engine"])).toBe(false);
    expect(matchPaths(["apps/engine/"], ["apps/engine-extra/main.ts"])).toBe(false);
    expect(matchPaths(["*.ts"], ["main.ts"])).toBe(true);
    expect(matchPaths(["*.ts"], ["src/main.ts"])).toBe(false);
    expect(matchPaths(["**/*.ts"], ["src/main.ts"])).toBe(true);
    expect(matchPaths(["**/*.ts"], ["main.ts"])).toBe(true);
    expect(matchPaths(["a?c"], ["abc"])).toBe(true);
    expect(matchPaths(["a?c"], ["ac"])).toBe(false);
    expect(matchPaths(["*"], ["a/b"])).toBe(false);
    expect(matchPaths(["a/**/b"], ["a/b"])).toBe(true);
    expect(matchPaths(["a/**/b"], ["a/x/y/b"])).toBe(true);
    expect(matchPaths(["apps/engine/**"], [])).toBe(false);
  });
});

describe("closeout command runner", () => {
  test("a passing command records exit 0, a clean tree, and the log hash", async () => {
    const fx = await fixture();
    try {
      const result = await run(fx, {
        items: [command("typecheck", [process.execPath, "-e", "process.exit(0)"])],
      });
      expect(result.blocked).toBeUndefined();
      expect(result.dispositions).toEqual([
        { id: "typecheck", kind: "command", state: "ran", message: "exited 0" },
      ]);
      const record = onlyRecord(fx.store);
      expect(record.producer).toEqual(PAWS_CLOSEOUT_PRODUCER);
      expect(record.evaluator).toEqual(PAWS_CLOSEOUT_PRODUCER);
      expect(record.specVersion).toBe("0.1");
      expect(record.itemId).toBe("typecheck");
      expect(record.base).toBe(fx.base);
      expect(record.head).toBe(fx.head);
      expect(record.policyDigest).toBe(DIGEST);
      expect(record.attempt).toBe(1);
      expect(record.exec.argv).toEqual([process.execPath, "-e", "process.exit(0)"]);
      expect(record.exec.exitCode).toBe(0);
      expect(record.exec.timedOut).toBe(false);
      expect(record.exec.dirty).toBe(false);
      expect(record.exec.headMoved).toBe(false);
      expect(record.exec.truncated).toBe(false);
      expect(record.exec.durationMs).toBeGreaterThanOrEqual(0);
      const artifact = record.artifacts[0];
      if (artifact === undefined) throw new Error("missing log artifact");
      const bytes = await readFile(join(fx.evidenceDir, artifact.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      expect(bytes.toString("utf8")).toContain("STDOUT\n");
    } finally {
      await fx.cleanup();
    }
  });

  test("detached commands use configured exclusions despite source pattern tampering", async () => {
    const fx = await fixture();
    try {
      fx.head = await commit(fx.repo, "large/file.txt", "excluded");
      await exec("git", [
        "-C",
        fx.repo,
        "sparse-checkout",
        "set",
        "--no-cone",
        "--",
        "/*",
        "!/large/",
        "!/README.md",
      ]);
      await run(
        fx,
        {
          items: [
            command("sparse", [
              process.execPath,
              "-e",
              'const fs = require("node:fs"); process.exit(!fs.existsSync("large") && fs.existsSync("README.md") ? 0 : 1)',
            ]),
          ],
        },
        { checkoutExclusions: ["large"] },
      );
      expect(onlyRecord(fx.store).exec.exitCode).toBe(0);
      expect(onlyRecord(fx.store).exec.dirty).toBe(false);
      expect(existsSync(join(fx.repo, "large"))).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("checkout filter failure blocks commands and removes the detached worktree", async () => {
    const fx = await fixture();
    try {
      fx.head = await commit(fx.repo, ".gitattributes", "README.md filter=broken\n");
      await exec("git", ["-C", fx.repo, "config", "filter.broken.smudge", "false"]);
      await exec("git", ["-C", fx.repo, "config", "filter.broken.required", "true"]);
      const result = await run(fx, {
        items: [command("check", [process.execPath, "-e", "process.exit(0)"])],
      });
      expect(result.blocked).toBe("could not populate a worktree at the candidate commit");
      expect(result.dispositions).toEqual([]);
      const listed = (await exec("git", ["-C", fx.repo, "worktree", "list", "--porcelain"])).stdout;
      expect(listed.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });

  test("a non-zero exit is recorded and does not time out", async () => {
    const fx = await fixture();
    try {
      await run(fx, { items: [command("typecheck", [process.execPath, "-e", "process.exit(4)"])] });
      const record = onlyRecord(fx.store);
      expect(record.exec.exitCode).toBe(4);
      expect(record.exec.timedOut).toBe(false);
      expect(record.exec.dirty).toBe(false);
      expect(record.exec.headMoved).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("timeout kills the process group", async () => {
    const fx = await fixture();
    const parentPid = join(fx.side, "parent.pid");
    const childPid = join(fx.side, "child.pid");
    const script = await writeScript(
      fx.side,
      "sleep-group.js",
      `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        fs.writeFileSync(process.argv[3], String(process.pid));
        spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", process.argv[2]], { stdio: "ignore" });
        setInterval(() => {}, 1000);
      `,
    );
    try {
      await run(fx, {
        items: [
          command("slow", [process.execPath, script, childPid, parentPid], { timeoutSeconds: 1 }),
        ],
      });
      const record = onlyRecord(fx.store);
      expect(record.exec.timedOut).toBe(true);
      expect(record.exec.exitCode).toBeNull();
      const parent = Number(readFileSync(parentPid, "utf8"));
      const child = Number(readFileSync(childPid, "utf8"));
      // Process-group signals return before every child has exited and been reaped.
      const deadline = Date.now() + 2_000;
      while ((alive(parent) || alive(child)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive(parent)).toBe(false);
      expect(alive(child)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  }, 15_000);

  test("a missing executable records that the command could not start", async () => {
    const fx = await fixture();
    try {
      const result = await run(fx, { items: [command("missing", ["/no/such/paws-closeout-bin"])] });
      expect(result.dispositions[0]?.message).toBe("command could not start");
      const record = onlyRecord(fx.store);
      expect(record.exec.exitCode).toBeNull();
      expect(record.exec.timedOut).toBe(false);
      expect(record.exec.headMoved).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("new dirt is a non-empty status that differs from the status before the command", async () => {
    const fx = await fixture();
    const script = await writeScript(
      fx.side,
      "dirty.js",
      `require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "note.txt"), "x\\n");`,
    );
    try {
      await run(fx, { items: [command("write", [process.execPath, script])] });
      const record = onlyRecord(fx.store);
      expect(record.exec.exitCode).toBe(0);
      expect(record.exec.dirty).toBe(true);
      expect(record.exec.headMoved).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("a command that commits records that HEAD moved", async () => {
    const fx = await fixture();
    try {
      await run(fx, {
        items: [command("commit", ["git", "commit", "--allow-empty", "-m", "move"])],
      });
      const record = onlyRecord(fx.store);
      expect(record.exec.exitCode).toBe(0);
      expect(record.exec.headMoved).toBe(true);
      expect(record.exec.dirty).toBe(false);
      const { stdout } = await exec("git", ["-C", fx.repo, "rev-parse", "HEAD"]);
      expect(stdout.trim()).toBe(fx.head);
    } finally {
      await fx.cleanup();
    }
  });

  test("setup may leave files, and a later command is not failed for that dirt", async () => {
    const fx = await fixture();
    const setupScript = await writeScript(
      fx.side,
      "setup-dirty.js",
      `require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "generated.txt"), "ok\\n");`,
    );
    try {
      const result = await run(fx, {
        setup: [setupStep("js", [process.execPath, setupScript])],
        items: [command("typecheck", [process.execPath, "-e", "process.exit(0)"])],
      });
      expect(result.dispositions.map((item) => item.state)).toEqual(["ran", "ran"]);
      expect(result.dispositions[0]?.message).toBe("exited 0");
      expect(result.dispositions[1]?.message).toBe("exited 0");
      const [setupRecord, commandRecord] = commandRecords(fx.store);
      expect(setupRecord?.exec.dirty).toBe(true);
      expect(setupRecord?.exec.exitCode).toBe(0);
      expect(setupRecord?.exec.headMoved).toBe(false);
      expect(commandRecord?.exec.dirty).toBe(false);
      expect(commandRecord?.exec.exitCode).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test("a failed setup skips later steps and commands", async () => {
    const fx = await fixture();
    const later = join(fx.side, "later");
    const commandMarker = join(fx.side, "command");
    const laterScript = await writeScript(
      fx.side,
      "later.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    try {
      const result = await run(fx, {
        setup: [
          setupStep("js", [process.execPath, "-e", "process.exit(1)"]),
          setupStep("worker", [process.execPath, laterScript, later]),
        ],
        items: [command("typecheck", [process.execPath, laterScript, commandMarker])],
      });
      expect(result.dispositions).toEqual([
        { id: "js", kind: "setup", state: "ran", message: "command exited 1" },
        { id: "worker", kind: "setup", state: "skipped", message: "setup failed" },
        { id: "typecheck", kind: "command", state: "skipped", message: "setup failed" },
      ]);
      expect(existsSync(later)).toBe(false);
      expect(existsSync(commandMarker)).toBe(false);
      expect(commandRecords(fx.store)).toHaveLength(2);
    } finally {
      await fx.cleanup();
    }
  });

  test("the command environment drops tokens, the oauth token, ssh, and cloud keys", async () => {
    const fx = await fixture();
    const script = await writeScript(
      fx.side,
      "env.js",
      `
        const keys = ["GH_TOKEN", "GITHUB_TOKEN", "OAUTH_TOKEN", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "KEEP_ME", "PATH"];
        const out = {};
        for (const key of keys) out[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
        process.stdout.write(JSON.stringify(out));
      `,
    );
    try {
      await run(
        fx,
        { items: [command("env", [process.execPath, script])] },
        {
          env: {
            ...process.env,
            GH_TOKEN: "gh-secret",
            GITHUB_TOKEN: "github-secret",
            OAUTH_TOKEN: "oauth-secret",
            SSH_AUTH_SOCK: "/tmp/agent-ssh",
            AWS_SECRET_ACCESS_KEY: "aws-secret",
            AWS_ACCESS_KEY_ID: "aws-id",
            KEEP_ME: "visible",
          },
        },
      );
      const record = onlyRecord(fx.store);
      const artifact = record.artifacts[0];
      const log = await readFile(join(fx.evidenceDir, artifact?.path ?? ""), "utf8");
      const seen = JSON.parse(logStdout(log)) as Record<string, string | null>;
      expect(seen.GH_TOKEN).toBeNull();
      expect(seen.GITHUB_TOKEN).toBeNull();
      expect(seen.OAUTH_TOKEN).toBeNull();
      expect(seen.SSH_AUTH_SOCK).toBeNull();
      expect(seen.AWS_SECRET_ACCESS_KEY).toBeNull();
      expect(seen.AWS_ACCESS_KEY_ID).toBeNull();
      expect(seen.KEEP_ME).toBe("visible");
      expect(seen.PATH).not.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test("commands run in a detached worktree and not in the agent checkout", async () => {
    const fx = await fixture();
    const cwdFile = join(fx.side, "cwd");
    const script = await writeScript(
      fx.side,
      "cwd.js",
      `
        const fs = require("node:fs");
        const path = require("node:path");
        fs.writeFileSync(process.argv[2], process.cwd());
        fs.writeFileSync(path.join(process.cwd(), "ran-here"), "1");
      `,
    );
    try {
      await run(fx, { items: [command("where", [process.execPath, script, cwdFile])] });
      const cwd = readFileSync(cwdFile, "utf8");
      expect(cwd).not.toBe(fx.repo);
      expect(cwd.startsWith(join(fx.home, "closeout", "tmp"))).toBe(true);
      expect(existsSync(join(fx.repo, "ran-here"))).toBe(false);
      expect(existsSync(cwd)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("an unreadable diff blocks when any requirement has paths, and nothing runs", async () => {
    const fx = await fixture();
    const marker = join(fx.side, "ran");
    const gitBin = join(fx.side, "git");
    await writeFile(
      gitBin,
      `#!/bin/sh\nif [ "$1" = "diff" ]; then echo "fatal: simulated diff failure" >&2; exit 1; fi\nexec /usr/bin/git "$@"\n`,
    );
    await chmod(gitBin, 0o755);
    const script = await writeScript(
      fx.side,
      "ran.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    try {
      const result = await run(
        fx,
        {
          items: [
            command("engine", [process.execPath, script, marker], { paths: ["apps/engine/**"] }),
          ],
        },
        { env: { ...process.env, PATH: `${fx.side}:${process.env.PATH ?? ""}` } },
      );
      expect(result.blocked?.startsWith("changed paths are unavailable")).toBe(true);
      expect(result.dispositions).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      expect(fx.store.records).toHaveLength(0);
      expect(existsSync(join(fx.home, "closeout", "tmp"))).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("a path miss skips the command and a requirement without paths still runs", async () => {
    const fx = await fixture();
    fx.head = await commit(fx.repo, "README.md", "changed\n");
    const marker = join(fx.side, "engine");
    const other = join(fx.side, "other");
    const script = await writeScript(
      fx.side,
      "mark.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    try {
      const result = await run(fx, {
        items: [
          command("engine", [process.execPath, script, marker], { paths: ["apps/engine/**"] }),
          command("always", [process.execPath, script, other]),
        ],
      });
      expect(result.dispositions).toEqual([
        { id: "engine", kind: "command", state: "skipped", message: "no changed path matches" },
        { id: "always", kind: "command", state: "ran", message: "exited 0" },
      ]);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(other)).toBe(true);
      expect(onlyRecord(fx.store).itemId).toBe("always");
    } finally {
      await fx.cleanup();
    }
  });

  test("a matching path runs the command", async () => {
    const fx = await fixture();
    fx.head = await commit(fx.repo, "apps/engine/main.ts", "export const engine = 1;\n");
    const marker = join(fx.side, "engine");
    const script = await writeScript(
      fx.side,
      "mark.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    try {
      const result = await run(fx, {
        items: [
          command("engine", [process.execPath, script, marker], { paths: ["apps/engine/**"] }),
        ],
      });
      expect(result.dispositions[0]?.state).toBe("ran");
      expect(existsSync(marker)).toBe(true);
      expect(onlyRecord(fx.store).head).toBe(fx.head);
    } finally {
      await fx.cleanup();
    }
  });

  test("a path miss on setup is not a failure, so later commands still run", async () => {
    const fx = await fixture();
    fx.head = await commit(fx.repo, "README.md", "changed\n");
    const marker = join(fx.side, "setup");
    const script = await writeScript(
      fx.side,
      "mark.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    try {
      const result = await run(fx, {
        setup: [
          setupStep("worker", [process.execPath, script, marker], { paths: ["apps/worker/**"] }),
        ],
        items: [command("typecheck", [process.execPath, "-e", "process.exit(0)"])],
      });
      expect(result.dispositions).toEqual([
        { id: "worker", kind: "setup", state: "skipped", message: "no changed path matches" },
        { id: "typecheck", kind: "command", state: "ran", message: "exited 0" },
      ]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("two concurrent retry attempts are serialized", async () => {
    const fx = await fixture();
    const gate = join(fx.side, "running");
    const script = await writeScript(
      fx.side,
      "serial.js",
      `
        const fs = require("node:fs");
        const gate = process.argv[2];
        try { fs.mkdirSync(gate); }
        catch (error) { fs.writeFileSync(gate + "-overlap", "1"); process.exit(0); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        fs.rmSync(gate, { recursive: true, force: true });
      `,
    );
    const retry: RetryPolicy = { maxFailedAttemptsPerItem: 5, scope: "candidate" };
    try {
      const [first, second] = await Promise.all([
        run(fx, { items: [command("typecheck", [process.execPath, script, gate])], retry }),
        run(fx, { items: [command("typecheck", [process.execPath, script, gate])], retry }),
      ]);
      expect(first.blocked).toBeUndefined();
      expect(second.blocked).toBeUndefined();
      expect(existsSync(`${gate}-overlap`)).toBe(false);
      const attempts = commandRecords(fx.store)
        .map((record) => record.attempt)
        .sort();
      expect(attempts).toEqual([1, 2]);
      expect(existsSync(join(fx.evidenceDir, "retry.lock"))).toBe(true);
    } finally {
      await fx.cleanup();
    }
  }, 15_000);

  test("an exhausted requirement is not executed", async () => {
    const fx = await fixture();
    const marker = join(fx.side, "ran");
    const script = await writeScript(
      fx.side,
      "mark.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    const execArgv = [process.execPath, script, marker];
    fx.store.records.push(failedRecord(fx, "typecheck", execArgv, 1));
    try {
      const result = await run(fx, {
        items: [command("typecheck", execArgv)],
        retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
      });
      expect(result.dispositions).toEqual([
        {
          id: "typecheck",
          kind: "command",
          state: "exhausted",
          message: "1 of 1 allowed failed attempts used. Stop retrying and ask for help.",
        },
      ]);
      expect(existsSync(marker)).toBe(false);
      expect(commandRecords(fx.store)).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });

  test("an exhausted setup step prevents later commands from running", async () => {
    const fx = await fixture();
    const marker = join(fx.side, "ran");
    const script = await writeScript(
      fx.side,
      "mark.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n");`,
    );
    const setupArgv = [process.execPath, "-e", "process.exit(1)"];
    fx.store.records.push(failedRecord(fx, "js", setupArgv, 1));
    fx.store.records.push(failedRecord(fx, "js", setupArgv, 2));
    try {
      const result = await run(fx, {
        setup: [setupStep("js", setupArgv)],
        items: [command("typecheck", [process.execPath, script, marker])],
        retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
      });
      expect(result.dispositions[0]?.state).toBe("exhausted");
      expect(result.dispositions[1]).toEqual({
        id: "typecheck",
        kind: "command",
        state: "skipped",
        message: "setup failed",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  test("task scope counts a failure from another head, and candidate scope does not", async () => {
    const fx = await fixture();
    const marker = join(fx.side, "ran");
    const script = await writeScript(
      fx.side,
      "mark.js",
      `require("node:fs").writeFileSync(process.argv[2], "ran\\n"); process.exit(1);`,
    );
    const execArgv = [process.execPath, script, marker];
    const otherHead = "b".repeat(40);
    try {
      fx.store.records.push(failedRecord(fx, "typecheck", execArgv, 1, { head: otherHead }));
      const candidateRun = await run(fx, {
        items: [command("typecheck", execArgv)],
        retry: { maxFailedAttemptsPerItem: 1, scope: "candidate" },
      });
      expect(candidateRun.dispositions[0]?.state).toBe("ran");
      expect(existsSync(marker)).toBe(true);

      const taskMarker = join(fx.side, "task-ran");
      const taskArgv = [process.execPath, script, taskMarker];
      const taskStore = memoryStore([
        failedRecord(fx, "typecheck", taskArgv, 1, { head: otherHead, task: "QM-31" }),
      ]);
      const taskRun = await runCloseoutCommands({
        repo: fx.repo,
        policy: policy({
          items: [command("typecheck", taskArgv)],
          retry: { maxFailedAttemptsPerItem: 1, scope: "task" },
        }),
        base: fx.base,
        head: fx.head,
        candidate: { session: "s", model: "m", provider: "p", task: "QM-31" },
        evidence: taskStore,
        evidenceDir: join(fx.root, "task-evidence"),
        home: fx.home,
      });
      expect(taskRun.dispositions[0]?.state).toBe("exhausted");
      expect(existsSync(taskMarker)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});

type Store = EvidenceStore & { records: EvidenceRecord[] };

type Fixture = {
  root: string;
  repo: string;
  home: string;
  evidenceDir: string;
  side: string;
  base: string;
  head: string;
  store: Store;
  cleanup: () => Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "paws-closeout-run-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const evidenceDir = join(root, "evidence");
  const side = join(root, "side");
  await mkdir(repo);
  await mkdir(home, { mode: 0o700 });
  await mkdir(evidenceDir);
  await mkdir(side);
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  const base = await commit(repo, "README.md", "paws\n");
  return {
    root,
    repo,
    home,
    evidenceDir,
    side,
    base,
    head: base,
    store: memoryStore(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function commit(repo: string, file: string, content: string): Promise<string> {
  const absolute = join(repo, file);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  await exec("git", ["-C", repo, "add", file]);
  await exec("git", ["-C", repo, "commit", "-m", file]);
  const { stdout } = await exec("git", ["-C", repo, "rev-parse", "HEAD"]);
  return stdout.trim();
}

function policy(input: {
  setup?: ResolvedSetup[];
  items?: ResolvedPolicyPresent["items"];
  retry?: RetryPolicy;
}): ResolvedPolicyPresent {
  return {
    source: "repo",
    digest: DIGEST,
    entryPath: ".agents/closeout.yaml",
    files: [],
    setup: input.setup ?? [],
    items: input.items ?? [],
    ...(input.retry ? { retry: input.retry } : {}),
  };
}

function command(
  id: string,
  execArgv: string[],
  extra?: { paths?: string[]; timeoutSeconds?: number },
): ResolvedCommand {
  return {
    id,
    kind: "command",
    gate: "beforePR",
    exec: execArgv,
    timeoutSeconds: extra?.timeoutSeconds ?? 30,
    ...(extra?.paths ? { paths: extra.paths } : {}),
  };
}

function setupStep(
  id: string,
  execArgv: string[],
  extra?: { paths?: string[]; timeoutSeconds?: number },
): ResolvedSetup {
  return {
    id,
    kind: "setup",
    gate: "beforePR",
    exec: execArgv,
    timeoutSeconds: extra?.timeoutSeconds ?? 30,
    ...(extra?.paths ? { paths: extra.paths } : {}),
  };
}

function run(
  fx: Fixture,
  spec: { setup?: ResolvedSetup[]; items?: ResolvedPolicyPresent["items"]; retry?: RetryPolicy },
  extra?: { env?: NodeJS.ProcessEnv; checkoutExclusions?: readonly string[] },
): Promise<CloseoutRunResult> {
  return runCloseoutCommands({
    repo: fx.repo,
    policy: policy(spec),
    base: fx.base,
    head: fx.head,
    candidate: { session: "impl", model: "test", provider: "paws" },
    evidence: fx.store,
    evidenceDir: fx.evidenceDir,
    home: fx.home,
    checkoutExclusions: extra?.checkoutExclusions,
    ...(extra?.env ? { env: extra.env } : {}),
  });
}

function memoryStore(initial: EvidenceRecord[] = []): Store {
  const records = [...initial];
  return {
    records,
    load() {
      return Promise.resolve({ records: [...records] });
    },
    add(record) {
      const duplicate = records.some(
        (existing) =>
          existing.itemId === record.itemId &&
          existing.base === record.base &&
          existing.head === record.head &&
          existing.policyDigest === record.policyDigest &&
          existing.attempt === record.attempt &&
          existing.recordType === record.recordType,
      );
      if (duplicate) return Promise.reject(new Error("duplicate evidence attempt"));
      records.push(record);
      return Promise.resolve();
    },
  };
}

function failedRecord(
  fx: Fixture,
  itemId: string,
  argv: string[],
  attempt: number,
  extra?: { head?: string; task?: string },
): CommandRecord {
  return {
    specVersion: "0.1",
    recordType: "command",
    ...(extra?.task ? { task: extra.task } : {}),
    itemId,
    base: fx.base,
    head: extra?.head ?? fx.head,
    policyDigest: DIGEST,
    attempt,
    evaluator: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    producer: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    exec: {
      argv,
      exitCode: 1,
      timedOut: false,
      dirty: false,
      headMoved: false,
      durationMs: 1,
      truncated: false,
    },
    artifacts: [],
  };
}

function commandRecords(store: Store): CommandRecord[] {
  return store.records.filter((record): record is CommandRecord => record.recordType === "command");
}

function onlyRecord(store: Store): CommandRecord {
  const records = commandRecords(store);
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) throw new Error("missing command record");
  return record;
}

function logStdout(log: string): string {
  const start = log.indexOf("STDOUT\n");
  const end = log.indexOf("\nSTDERR\n");
  return log.slice(start + "STDOUT\n".length, end);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // A container init may leave a killed descendant as a zombie until it reaps it.
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function writeScript(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}
