import { setJournalSink } from "../journal";
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
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createCloseoutSession, workspacePolicyFiles } from "../closeout-spec";
import { startAskTeamBridge } from "./ask-team";
import {
  CLOSEOUT_FINISH_UNAVAILABLE,
  CLOSEOUT_STOP_TIMEOUT_SECONDS,
  closeoutFinishLine,
  closeoutStopCommand,
  codexConfigWithStopHook,
  codexStopHookTrustHash,
  installCloseoutStopHook,
  installCodexSkillsHome,
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
      JSON.stringify({
        required: [
          { id: "engine-test", status: "exhausted" },
          { id: "lint", status: "deferred" },
        ],
        pending: [],
        blocked: "Cannot finish yet. Check engine-test is exhausted.",
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
  writeTestPolicy(repo);
  writeFileSync(join(repo, "src.txt"), "change\n");
  const pending = await hookAgainst(pendingRoot, "pending", repo);
  expect(pending.status).toBe(0);
  expect(JSON.parse(pending.stdout)).toEqual({
    decision: "block",
    reason: "Cannot finish yet. Check test is not finished. Call get_closeout.",
  });
});

test("finish answers from recorded results while a new report would take a minute", async () => {
  const root = temp();
  const repo = join(root, "repo");
  initRepo(repo);
  writeTestPolicy(repo);
  const runDirectory = join(root, "run");
  const socketPath = join(runDirectory, "ask-team.sock");
  const timers: ReturnType<typeof setTimeout>[] = [];
  let slow = false;
  const controller = new AbortController();
  const bridge = await startAskTeamBridge({
    socketPath,
    context: { itemId: "ENG-1", runId: "slow", role: "implementer", worktreePath: repo },
    closeoutPolicy: async () => {
      if (slow) await new Promise((resolve) => timers.push(setTimeout(resolve, 60_000)));
      return workspacePolicyFiles(repo);
    },
    commandGuard: {
      hostAccess: true,
      worktree: repo,
      home: join(root, "home"),
      pawsRoot: join(root, "paws"),
    },
    signal: controller.signal,
  });
  const notFinished = {
    decision: "block",
    reason: "Cannot finish yet. Check test is not finished. Call get_closeout.",
  };
  try {
    // Listed before any change, so nothing is required yet; the change below makes test apply.
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "policy"], { cwd: repo });
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
    expect(
      JSON.parse(JSON.parse(await callTool(socketPath, "get_closeout", {})).answer),
    ).toMatchObject({
      required: [],
    });
    writeFileSync(join(repo, "src.txt"), "change\n");
    const installed = await installCloseoutStopHook({
      agent: "claude",
      runDirectory,
      socketPath,
      sourceEnv: {},
    });
    const finish = async () => {
      slow = true;
      const started = Date.now();
      const ran = await runScript(installed?.scriptPath ?? "");
      expect(Date.now() - started).toBeLessThan(10_000);
      slow = false;
      return JSON.parse(ran.stdout) as unknown;
    };
    const slowPath = async () =>
      JSON.parse(closeoutFinishLine((await bridge.closeoutReport()) ?? "")) as unknown;

    expect(await finish()).toEqual(notFinished);
    expect(await slowPath()).toEqual(notFinished);

    expect(JSON.parse(await callTool(socketPath, "run_closeout", { id: "test" })).error).toBe(
      undefined,
    );
    expect(await finish()).toEqual({});
    expect(await slowPath()).toEqual({});

    spawnSync("git", ["add", "src.txt"], { cwd: repo });
    spawnSync("git", ["commit", "-m", "change"], { cwd: repo });
    expect(await finish()).toEqual(notFinished);
    expect(await slowPath()).toEqual(notFinished);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await bridge.close();
  }
});

test("finish with nothing recorded and a slow policy is refused as unavailable in time", async () => {
  const root = temp();
  const repo = join(root, "repo");
  initRepo(repo);
  writeTestPolicy(repo);
  writeFileSync(join(repo, "src.txt"), "change\n");
  const runDirectory = join(root, "run");
  const socketPath = join(runDirectory, "ask-team.sock");
  const timers: ReturnType<typeof setTimeout>[] = [];
  const controller = new AbortController();
  const bridge = await startAskTeamBridge({
    socketPath,
    context: { itemId: "ENG-1", runId: "unlisted", role: "implementer", worktreePath: repo },
    closeoutPolicy: async () => {
      await new Promise((resolve) => timers.push(setTimeout(resolve, 60_000)));
      return workspacePolicyFiles(repo);
    },
    commandGuard: {
      hostAccess: true,
      worktree: repo,
      home: join(root, "home"),
      pawsRoot: join(root, "paws"),
    },
    signal: controller.signal,
  });
  try {
    const started = Date.now();
    const ran = JSON.parse(await callTool(socketPath, "closeout_finish", {})) as { answer: string };
    expect(ran.answer).toBe(CLOSEOUT_FINISH_UNAVAILABLE);
    expect(Date.now() - started).toBeLessThan(11_000);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await bridge.close();
  }
}, 20_000);

test("the last recorded report answers only for the head it was recorded at", async () => {
  const root = temp();
  const repo = join(root, "repo");
  initRepo(repo);
  writeTestPolicy(repo);
  writeFileSync(join(repo, "src.txt"), "change\n");
  const session = createCloseoutSession(repo, { policy: async () => workspacePolicyFiles(repo) });
  const report = await session.report();
  expect(await session.lastRecorded()).toBe(report);
  spawnSync("git", ["add", "src.txt"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "change"], { cwd: repo });
  expect(await session.lastRecorded()).toBeUndefined();
  expect(await session.recorded()).toBeDefined();
  expect(await session.lastRecorded()).toBeDefined();
});

test("the stop hook waits 25 seconds for Paws, inside the hook's own limit", async () => {
  const root = temp();
  const installed = await installCloseoutStopHook({
    agent: "claude",
    runDirectory: join(root, "run"),
    socketPath: join(root, "run", "ask-team.sock"),
    sourceEnv: {},
  });
  const script = readFileSync(installed?.scriptPath ?? "", "utf8");
  expect(script).toContain("const WAIT_MS = 25000;");
  expect(CLOSEOUT_STOP_TIMEOUT_SECONDS).toBe(30);
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
  const command = closeoutStopCommand(process.execPath, installed?.scriptPath ?? "");
  expect(command).toBe(`'${process.execPath}' '${join(runDirectory, "closeout-stop.ts")}'`);
  const hash = codexStopHookTrustHash(command, CLOSEOUT_STOP_TIMEOUT_SECONDS);
  expect(config).toContain(`trusted_hash = "${hash}"`);
  expect(config).toContain(`[hooks.state."${join(overlay, "hooks.json")}:stop:0:0"]`);
  const hooks = JSON.parse(readFileSync(join(overlay, "hooks.json"), "utf8")) as {
    hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> };
  };
  expect(hooks.hooks.Stop[0]?.hooks[0]).toEqual({
    type: "command",
    command,
    timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
  });
  expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"token":"keep"}\n');
});

test("the Claude stop hook runs the script with this process's Bun", async () => {
  const root = temp();
  const installed = await installCloseoutStopHook({
    agent: "claude",
    runDirectory: join(root, "run"),
    socketPath: join(root, "run", "ask-team.sock"),
    sourceEnv: {},
  });
  const meta = installed?.sessionMeta as {
    claudeCode: { options: { settings: { hooks: { Stop: { hooks: unknown[] }[] } } } };
  };
  expect(meta.claudeCode.options.settings.hooks.Stop[0]?.hooks[0]).toEqual({
    type: "command",
    command: process.execPath,
    args: [join(root, "run", "closeout-stop.ts")],
    timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
  });
});

test("installing the stop hook needs no python3 on PATH", async () => {
  const root = temp();
  // Nothing is on PATH: a lookup for python3, or anything else, finds nothing.
  const which = spyOn(Bun, "which").mockReturnValue(null);
  try {
    for (const agent of ["claude", "codex"] as const)
      expect(
        await installCloseoutStopHook({
          agent,
          runDirectory: join(root, agent),
          socketPath: join(root, agent, "ask-team.sock"),
          sourceEnv: { HOME: join(root, "home") },
        }),
      ).toBeDefined();
    expect(which).not.toHaveBeenCalledWith("python3");
  } finally {
    which.mockRestore();
  }
});

test("the stop hook file imports only Bun and Node built-ins", async () => {
  const root = temp();
  const installed = await installCloseoutStopHook({
    agent: "claude",
    runDirectory: join(root, "run"),
    socketPath: join(root, "run", "ask-team.sock"),
    sourceEnv: {},
  });
  const source = readFileSync(installed?.scriptPath ?? "", "utf8");
  expect(source.startsWith(`#!${process.execPath}\n`)).toBe(true);
  const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g)];
  expect(imports.length).toBeGreaterThan(0);
  for (const match of imports) expect(match[1] ?? match[2]).toMatch(/^(node:|bun(:|$))/);
  expect(source).not.toContain("require(");
});

test("the stop hook prints the answer it gets on the socket", async () => {
  expect(await hookWithAnswer(JSON.stringify({ id: 1, answer: "{}" }))).toEqual({
    status: 0,
    stdout: "{}\n",
  });
  const blocked = JSON.stringify({ decision: "block", reason: "Check test is not finished." });
  expect(await hookWithAnswer(JSON.stringify({ id: 1, answer: blocked }))).toEqual({
    status: 0,
    stdout: `${blocked}\n`,
  });
});

test("a malformed answer prints the unavailable block", async () => {
  for (const answer of [
    "not json",
    JSON.stringify({ id: 1 }),
    JSON.stringify({ id: 1, answer: "[]" }),
    JSON.stringify({ id: 1, answer: '{"decision":"allow"}' }),
    JSON.stringify({ id: 1, answer: '{"decision":"block","reason":"x","continue":false}' }),
  ])
    expect(await hookWithAnswer(answer)).toEqual({
      status: 0,
      stdout: `${CLOSEOUT_FINISH_UNAVAILABLE}\n`,
    });
});

test(
  "a socket that never answers prints the unavailable block and the hook exits by itself",
  async () => {
    const started = Date.now();
    const ran = await hookWithAnswer(null);
    expect(ran).toEqual({ status: 0, stdout: `${CLOSEOUT_FINISH_UNAVAILABLE}\n` });
    expect(Date.now() - started).toBeLessThan(CLOSEOUT_STOP_TIMEOUT_SECONDS * 1000);
  },
  (CLOSEOUT_STOP_TIMEOUT_SECONDS + 5) * 1000,
);

/** Run the generated hook against a fake socket that answers `answer`, or never when null. */
async function hookWithAnswer(answer: string | null): Promise<{ status: number; stdout: string }> {
  const root = temp();
  const runDirectory = join(root, "run");
  const socketPath = join(runDirectory, "ask-team.sock");
  const installed = await installCloseoutStopHook({
    agent: "claude",
    runDirectory,
    socketPath,
    sourceEnv: {},
  });
  const requests: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      requests.push(chunk);
      if (answer !== null) socket.write(`${answer}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const child = Bun.spawn([process.execPath, installed?.scriptPath ?? ""], {
      stdin: Buffer.from('{"hook_event_name":"Stop"}'),
      stdout: "pipe",
      timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS * 1000,
      killSignal: "SIGKILL",
    });
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(requests.join("")).toBe('{"id":1,"tool":"closeout_finish","arguments":{}}\n');
    return { status, stdout };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

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

test("the turn-end report waits for a check the agent stopped waiting for", async () => {
  const root = temp();
  const repo = join(root, "repo");
  initRepo(repo);
  writeTestPolicy(repo, ["sh", "-c", "sleep 1"]);
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-m", "policy"], { cwd: repo });
  writeFileSync(join(repo, "src.txt"), "change\n");
  const socketPath = join(root, "run", "ask-team.sock");
  const bridge = await startAskTeamBridge({
    socketPath,
    context: { itemId: "ENG-1", runId: "gave-up", role: "implementer", worktreePath: repo },
    commandGuard: {
      hostAccess: true,
      worktree: repo,
      home: join(root, "home"),
      pawsRoot: join(root, "paws"),
    },
    signal: new AbortController().signal,
  });
  try {
    const call = connect(socketPath, () =>
      call.write(`${JSON.stringify({ id: 1, tool: "run_closeout", arguments: { id: "test" } })}\n`),
    );
    call.on("error", () => undefined);
    await Bun.sleep(300);
    call.destroy();
    const report = JSON.parse((await bridge.closeoutReport()) ?? "") as {
      required: { id: string; status: string; result?: { exitCode: number } }[];
    };
    expect(report.required).toMatchObject([
      { id: "test", status: "passed", result: { exitCode: 0 } },
    ]);
  } finally {
    await bridge.close();
  }
});

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
  const socketPath = join(runDirectory, "ask-team.sock");
  const controller = new AbortController();
  const bridge = await startAskTeamBridge({
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
  const socketPath = join(runDirectory, "ask-team.sock");
  const controller = new AbortController();
  const bridge = await startAskTeamBridge({
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

test("overlay propagates unexpected source errors without logging them twice", async () => {
  const root = temp();
  const source = join(root, "source");
  const skills = join(root, "skills");
  mkdirSync(skills);
  writeFileSync(source, "not a directory");
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await expect(
      installCodexSkillsHome({
        runDirectory: join(root, "run"),
        sourceEnv: { CODEX_HOME: source },
        codexSkills: skills,
      }),
    ).rejects.toThrow();
    expect(lines).toEqual([]);
  } finally {
    restore();
  }
});
