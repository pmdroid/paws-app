import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { startHostToolBridge } from "./ask-team";
import {
  CLOSEOUT_FINISH_UNAVAILABLE,
  CLOSEOUT_STOP_TIMEOUT_SECONDS,
  closeoutFinishLine,
  codexConfigWithStopHook,
  codexStopHookTrustHash,
  installCloseoutStopHook,
} from "./closeout-hook";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("finish is allowed when nothing is pending and only exhausted checks block it", () => {
  expect(closeoutFinishLine(JSON.stringify({ pending: [], blocked: null }))).toBe("{}");
  expect(closeoutFinishLine('{"pending":["test"],"blocked":null}')).toBe(
    JSON.stringify({
      decision: "block",
      reason: "Cannot finish yet. Check test is not finished. Call get_closeout.",
    }),
  );
  expect(closeoutFinishLine('{"pending":["prepare","engine"],"blocked":null}')).toContain(
    "Checks prepare, engine are not finished.",
  );
  expect(
    closeoutFinishLine(
      JSON.stringify({
        required: [{ id: "prepare", status: "exhausted" }],
        pending: [],
        blocked:
          "Cannot finish yet. Check prepare is exhausted. Failed attempts 1 of 1. Hint: Run true.",
      }),
    ),
  ).toBe("{}");
  expect(
    closeoutFinishLine(
      JSON.stringify({ required: [], pending: [], blocked: "The Closeout policy is invalid." }),
    ),
  ).toContain("The Closeout policy is invalid.");
  expect(
    closeoutFinishLine('{"pending":["engine"],"blocked":"changed paths are unavailable"}'),
  ).toBe(
    JSON.stringify({
      decision: "block",
      reason:
        "Cannot finish yet. changed paths are unavailable. Pending checks: engine. Call get_closeout.",
    }),
  );
  expect(closeoutFinishLine("")).toBe(CLOSEOUT_FINISH_UNAVAILABLE);
  expect(closeoutFinishLine("[]")).toBe(CLOSEOUT_FINISH_UNAVAILABLE);
  expect(closeoutFinishLine('{"pending":[1],"blocked":null}')).toBe(CLOSEOUT_FINISH_UNAVAILABLE);
  expect(closeoutFinishLine('{"blocked":null}')).toBe(CLOSEOUT_FINISH_UNAVAILABLE);
});

test("codex stop trust hash matches the 0.159.3 command fingerprint", () => {
  expect(codexStopHookTrustHash("/tmp/tmp.jNUmUbOf7c/stop-hook", 30)).toBe(
    "sha256:27857bd86af697f8f80138f6067bb060ed077bd92458046d9981925feb488f1f",
  );
  expect(codexStopHookTrustHash("/tmp/tmp.jNUmUbOf7c/stop-hook", 31)).not.toBe(
    "sha256:27857bd86af697f8f80138f6067bb060ed077bd92458046d9981925feb488f1f",
  );
});

test("codex overlay config forces hooks on and records only the stop hook trust", () => {
  const key = "/tmp/run/codex-home/hooks.json:stop:0:0";
  const hash = "sha256:abc";
  const patched = codexConfigWithStopHook(
    'model = "gpt"\n[features]\nhooks = false\n\n[sandbox]\nhooks = false\n',
    key,
    hash,
  );
  expect(patched).toContain('model = "gpt"');
  expect(patched).toContain("hooks = true");
  expect(patched).toContain("[sandbox]\nhooks = false");
  expect(patched).toContain(`[hooks.state."${key}"]`);
  expect(patched).toContain(`trusted_hash = "${hash}"`);
  expect(patched).toContain("enabled = true");
  expect(codexConfigWithStopHook("features.hooks = false\n", key, hash)).toContain(
    "features.hooks = true",
  );
  expect(
    codexConfigWithStopHook('features = { sandbox = "workspace-write" }\n', key, hash),
  ).toContain('features = { sandbox = "workspace-write", hooks = true }');
  expect(codexConfigWithStopHook("features = { hooks = false }\n", key, hash)).toContain(
    "features = { hooks = true }",
  );
  expect(codexConfigWithStopHook("", key, hash)).toContain("[features]\nhooks = true");
});

test("grok does not get a stop hook", async () => {
  const root = temp();
  expect(
    await installCloseoutStopHook({
      agent: "grok",
      runDirectory: join(root, "run"),
      socketPath: join(root, "run", "ask-team.sock"),
      sourceEnv: {},
    }),
  ).toBeUndefined();
});

test("the stop hook allows an empty policy and refuses a pending check", async () => {
  const root = temp();
  const empty = await hookAgainst(root, "empty");
  expect(empty.status).toBe(0);
  expect(empty.stdout.trim()).toBe("{}");
  expect(empty.tools).not.toContain("closeout_finish");

  const pendingRoot = temp();
  const repo = join(pendingRoot, "repo");
  initRepo(repo);
  writeFileSync(
    join(repo, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["true"]',
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "src.txt"), "change\n");
  const pending = await hookAgainst(pendingRoot, "pending", repo);
  expect(pending.status).toBe(0);
  expect(JSON.parse(pending.stdout)).toEqual({
    decision: "block",
    reason: "Cannot finish yet. Check test is not finished. Call get_closeout.",
  });
});

test("a dead closeout socket still refuses finish", async () => {
  const root = temp();
  const installed = await installCloseoutStopHook({
    agent: "claude",
    runDirectory: join(root, "run"),
    socketPath: join(root, "run", "missing.sock"),
    sourceEnv: {},
  });
  const ran = spawnSync(installed?.scriptPath ?? "", { encoding: "utf8" });
  expect(ran.status).toBe(0);
  expect(ran.stdout.trim()).toBe(CLOSEOUT_FINISH_UNAVAILABLE);
});

test("codex home overlay keeps login links and does not edit the source home", async () => {
  const root = temp();
  const source = join(root, "source-codex");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "auth.json"), '{"token":"keep"}\n');
  writeFileSync(
    join(source, "config.toml"),
    '[features]\nhooks = false\nmodel_provider = "openai"\n',
  );
  const runDirectory = join(root, "run");
  const installed = await installCloseoutStopHook({
    agent: "codex",
    runDirectory,
    socketPath: join(runDirectory, "ask-team.sock"),
    sourceEnv: { CODEX_HOME: source },
  });
  const overlay = installed?.env.CODEX_HOME ?? "";
  expect(overlay).toBe(join(runDirectory, "codex-home"));
  expect(lstatSync(join(overlay, "auth.json")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(overlay, "auth.json"))).toBe(join(source, "auth.json"));
  expect(readFileSync(join(source, "config.toml"), "utf8")).toContain("hooks = false");
  const config = readFileSync(join(overlay, "config.toml"), "utf8");
  expect(config).toContain("hooks = true");
  expect(config).toContain('model_provider = "openai"');
  const scriptPath = installed?.scriptPath ?? "";
  const hash = codexStopHookTrustHash(scriptPath, CLOSEOUT_STOP_TIMEOUT_SECONDS);
  expect(config).toContain(`trusted_hash = "${hash}"`);
  expect(config).toContain(`[hooks.state."${join(overlay, "hooks.json")}:stop:0:0"]`);
  const hooks = JSON.parse(readFileSync(join(overlay, "hooks.json"), "utf8")) as {
    hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> };
  };
  expect(hooks.hooks.Stop[0]?.hooks[0]).toEqual({
    type: "command",
    command: scriptPath,
    timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
  });
  expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"token":"keep"}\n');
});

function runScript(scriptPath: string): Promise<{ status: number | null; stdout: string }> {
  const child = spawn(scriptPath) as ChildProcessWithoutNullStreams;
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout }));
  });
}

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-hook-"));
  roots.push(root);
  return root;
}

async function hookAgainst(
  root: string,
  name: string,
  worktree = join(root, "work"),
): Promise<{ status: number | null; stdout: string; tools: string }> {
  mkdirSync(worktree, { recursive: true });
  const runDirectory = join(root, "run");
  const socketRoot = mkdtempSync("/var/tmp/paws-hook-socket-");
  roots.push(socketRoot);
  const socketPath = join(socketRoot, "ask-team.sock");
  const controller = new AbortController();
  const bridge = await startHostToolBridge({
    socketPath,
    context: { itemId: "ENG-1", runId: name, role: "implementer", worktreePath: worktree },
    signal: controller.signal,
  });
  try {
    const installed = await installCloseoutStopHook({
      agent: "claude",
      runDirectory,
      socketPath,
      sourceEnv: {},
    });
    const ran = await runScript(installed?.scriptPath ?? "");
    const tools = bridge.mcpServer.env.find((item) => item.name === "PAWS_HOST_TOOLS")?.value ?? "";
    return { status: ran.status, stdout: ran.stdout, tools };
  } finally {
    await bridge.close();
  }
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

test("a code task's first finish asks for open_pull_request and the second finish ends", async () => {
  const root = temp();
  const runs = await finishTwice(root, false);
  expect(JSON.parse(runs[0] ?? "")).toEqual({
    decision: "block",
    reason:
      "Cannot finish yet. Commit your work, then call open_pull_request with a title and a description. If this task needs no code change, say why and finish.",
  });
  expect(runs[1]).toBe("{}");
});

test("finish ends right away once the agent called open_pull_request", async () => {
  const root = temp();
  expect(await finishTwice(root, true)).toEqual(["{}", "{}"]);
});

async function finishTwice(root: string, openFirst: boolean): Promise<string[]> {
  const worktree = join(root, "work");
  mkdirSync(worktree, { recursive: true });
  const runDirectory = join(root, "run");
  const socketRoot = mkdtempSync("/var/tmp/paws-hook-socket-");
  roots.push(socketRoot);
  const socketPath = join(socketRoot, "ask-team.sock");
  const controller = new AbortController();
  const bridge = await startHostToolBridge({
    socketPath,
    context: { itemId: "ENG-1", runId: "pr", role: "implementer", worktreePath: worktree },
    pullRequest: { async update() {} },
    signal: controller.signal,
  });
  try {
    if (openFirst)
      await callTool(socketPath, "open_pull_request", { title: "Change", body: "Why." });
    const installed = await installCloseoutStopHook({
      agent: "claude",
      runDirectory,
      socketPath,
      sourceEnv: {},
    });
    const first = await runScript(installed?.scriptPath ?? "");
    const second = await runScript(installed?.scriptPath ?? "");
    return [first.stdout.trim(), second.stdout.trim()];
  } finally {
    await bridge.close();
  }
}

function callTool(
  socketPath: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () =>
      socket.write(`${JSON.stringify({ id: 1, tool, arguments: args })}\n`),
    );
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
}
