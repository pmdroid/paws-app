import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { startAskTeamBridge } from "../src/acp/ask-team";
import { loggedSessionCloseout } from "../src/closeout";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "skipped-check-"));
  roots.push(root);
  return root;
}
function writeTestPolicy(repo: string, exec: readonly string[] = ["true"]): void {
  writeFileSync(
    join(repo, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ${JSON.stringify(exec)}`,
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
}

function initRepo(root: string): void {
  mkdirSync(join(root, ".agents"), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
}

for (const refused of [false, true]) {
  test(`checks turn completes skipped commands, refused=${refused}`, async () => {
    const root = temp();
    const repo = join(root, "repo");
    initRepo(repo);
    writeTestPolicy(repo);
    const policy = join(repo, ".agents", "closeout.yaml");
    writeFileSync(
      policy,
      readFileSync(policy, "utf8") +
        `
  - id: skipped
    kind: command
    gate: beforePR
    exec: ["${refused ? "curl" : "true"}"]
    timeoutSeconds: 30
`,
    );
    const bridge = await startAskTeamBridge({
      socketPath: join(root, "ask.sock"),
      context: {
        itemId: "ENG-1",
        runId: "checks-ENG-1-head-1",
        role: "implementer",
        worktreePath: repo,
      },
      commandGuard: {
        worktree: repo,
        home: join(root, "home"),
        pawsRoot: join(root, "paws"),
        hostAccess: !refused,
      },
      signal: new AbortController().signal,
    });
    try {
      const socket = connect(join(root, "ask.sock"));
      await new Promise<void>((resolve) => {
        socket.on("connect", () =>
          socket.write(
            JSON.stringify({ id: 1, tool: "run_closeout", arguments: { id: "test" } }) + "\n",
          ),
        );
        socket.on("data", () => resolve());
      });
      socket.destroy();
      const report = JSON.parse((await bridge.closeoutReport())!);
      expect(
        report.required.find((check: { id: string }) => check.id === "test").result.exitCode,
      ).toBe(0);
      const skipped = report.required.find((check: { id: string }) => check.id === "skipped");
      if (refused) {
        expect(skipped.result).toBeUndefined();
        expect(() =>
          loggedSessionCloseout(JSON.stringify(report), {
            itemId: "skipped",
            argv: ["curl"],
            expectedHead: report.head,
            timeoutSeconds: 30,
            logFile: join(root, "log"),
            artifactPath: "log",
            cwd: repo,
          }),
        ).toThrow("no result for skipped (it never started)");
      } else {
        expect(skipped.result.exitCode).toBe(0);
        expect(report.pending).toEqual([]);
      }
    } finally {
      await bridge.close();
    }
  });
}
