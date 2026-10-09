import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { git } from "./git";
import { minimalAgentEnv } from "./env";
import { executeItem } from "./executor";
import { checkOwnLogin, runAgent } from "./run";
import type { FakeResult, FakeScript } from "./testing/script";
import type { AcpEvent } from "./types";

const fakeAgent = new URL("./testing/fake-agent.ts", import.meta.url).pathname;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("minimal env drops tokens and cloud keys and keeps HOME", () => {
  const env = minimalAgentEnv({
    HOME: "/home/dev",
    PATH: "/usr/bin",
    GH_TOKEN: "gh",
    GITHUB_TOKEN: "github",
    SSH_AUTH_SOCK: "/tmp/ssh",
    AWS_SECRET_ACCESS_KEY: "aws",
    ANTHROPIC_API_KEY: "sk",
    OPENAI_API_KEY: "sk",
  });
  expect(env.HOME).toBe("/home/dev");
  expect(env.PATH).toBe("/usr/bin");
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.SSH_AUTH_SOCK).toBeUndefined();
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

test("initialize reports auth methods and does not call authenticate", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    authMethods: [
      { id: "claude-ai-login", name: "Claude Subscription", type: "terminal" },
      { id: "api-key", name: "API key" },
    ],
    steps: [],
  };
  const files = await writeScript(layout.root, script);
  const auth = await checkOwnLogin({
    role: "implementer",
    command: process.execPath,
    args: [fakeAgent],
    env: agentEnv(files.resultPath, files.scriptPath),
  });
  expect(auth.authenticateCalled).toBe(false);
  expect(auth.credentialsRead).toBe(false);
  expect(auth.terminalAuthAdvertised).toBe(true);
  expect(auth.protocolAuthAdvertised).toBe(true);
  expect(auth.authMethods.map((method) => method.id)).toEqual(["claude-ai-login", "api-key"]);
  const trace = await readResult(files.resultPath);
  expect(trace.methods).toEqual(["initialize"]);
  expect(trace.methods).not.toContain("authenticate");
});

test("fake agent streams events, guards permissions, and checkpoints", async () => {
  const layout = await layoutRepo();
  const events: AcpEvent[] = [];
  const script: FakeScript = {
    authMethods: [{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" }],
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from agent" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "edit readme", priority: "high", status: "pending" }],
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Edit README",
          kind: "edit",
          status: "pending",
          locations: [{ path: join(layout.worktree, "README.md") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "edit",
          title: "Edit README",
          kind: "edit",
          locations: [{ path: join(layout.worktree, "README.md") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "ssh",
          title: "read ssh",
          kind: "read",
          locations: [{ path: join(layout.home, ".ssh", "id_rsa") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "paws",
          title: "read paws db",
          kind: "read",
          locations: [{ path: join(layout.pawsRoot, "paws.db") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "gh-config",
          title: "read gh config",
          kind: "read",
          locations: [{ path: join(layout.home, ".config", "gh", "hosts.yml") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "keychain",
          title: "read keychain",
          kind: "read",
          locations: [{ path: join(layout.home, "Library", "Keychains", "login.keychain-db") }],
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "push",
          title: "git push",
          kind: "execute",
          rawInput: { command: "git push origin HEAD" },
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "gh",
          title: "gh pr create",
          kind: "execute",
          rawInput: { command: "gh pr create" },
        },
      },
      {
        type: "permission",
        toolCall: {
          toolCallId: "test",
          title: "bun test",
          kind: "execute",
          rawInput: { command: "bun test" },
        },
      },
      { type: "fs_write", path: join(layout.worktree, "notes.txt"), content: "wip\n" },
      { type: "fs_write", path: join(layout.home, ".ssh", "stolen"), content: "nope" },
      { type: "fs_read", path: join(layout.worktree, "README.md") },
      { type: "terminal", command: "printf", args: ["ok"] },
      { type: "terminal", command: "git", args: ["push"] },
      { type: "end", stopReason: "end_turn" },
    ],
  };
  const files = await writeScript(layout.root, script);
  const result = await executeItem({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-1",
    owner: "acme",
    repo: "demo",
    remoteUrl: layout.source,
    prompt: "add notes",
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: [fakeAgent],
    env: agentEnv(files.resultPath, files.scriptPath),
    timeoutMs: 10_000,
    onEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.branch).toBe("paws/eng-1");
  expect(result.run.auth?.authenticateCalled).toBe(false);
  expect(result.run.acpStopReason).toBe("end_turn");
  expect(result.run.checkpoint?.committed).toBe(true);
  expect(result.run.agentExited).toBe(true);
  expect(await readFile(join(layout.worktree, "notes.txt"), "utf8")).toBe("wip\n");
  await expect(readFile(join(layout.home, ".ssh", "stolen"), "utf8")).rejects.toThrow();

  const trace = await readResult(files.resultPath);
  expect(trace.methods).not.toContain("authenticate");
  expect(outcome(trace, "edit")).toBe("allow");
  expect(outcome(trace, "test")).toBe("allow");
  for (const id of ["ssh", "paws", "gh-config", "keychain", "push", "gh"]) {
    expect(outcome(trace, id), id).toBe("deny");
  }
  expect(trace.fs.find((entry) => entry.path.endsWith("notes.txt"))?.ok).toBe(true);
  expect(trace.fs.find((entry) => entry.path.endsWith("stolen"))?.ok).toBe(false);
  expect(trace.fs.find((entry) => entry.op === "read")?.content).toBe("hello\n");
  expect(trace.terminals.find((entry) => entry.command === "printf")).toMatchObject({
    ok: true,
    output: "ok",
  });
  expect(trace.terminals.find((entry) => entry.command === "git")?.ok).toBe(false);

  expect(events.some((event) => event.type === "auth_checked")).toBe(true);
  expect(events.some((event) => event.type === "session_started")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "session_update" &&
        event.update.sessionUpdate === "agent_message_chunk" &&
        event.update.content.type === "text" &&
        event.update.content.text === "hello from agent",
    ),
  ).toBe(true);
  expect(
    events.some((event) => event.type === "prompt_complete" && event.stopReason === "end_turn"),
  ).toBe(true);
  expect(events.some((event) => event.type === "checkpoint" && event.checkpoint.committed)).toBe(
    true,
  );
  const transcript = await readFile(join(layout.pawsRoot, "runs", "run-1", "acp.jsonl"), "utf8");
  expect(transcript).toContain("hello from agent");
}, 20_000);

test("ask_team hook is invoked through the injected MCP tool", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    steps: [{ type: "ask_team", question: "Include archived rows?", options: ["yes", "no"] }],
  };
  const files = await writeScript(layout.root, script);
  const result = await runAgent({
    role: "reviewer",
    itemId: "ENG-1",
    runId: "run-ask",
    prompt: "need a decision",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: [fakeAgent],
    env: agentEnv(files.resultPath, files.scriptPath),
    askTeam: {
      async ask(request) {
        expect(request.question).toBe("Include archived rows?");
        expect(request.options).toEqual(["yes", "no"]);
        return { answer: "yes" };
      },
    },
    onEvent: () => undefined,
  });
  expect(result.acpStopReason).toBe("end_turn");
  const trace = await readResult(files.resultPath);
  expect(trace.askTeam).toEqual({ ok: true, text: "yes" });
  expect(trace.mcpServers[0]?.name).toBe("paws");
  expect(trace.methods).not.toContain("authenticate");
});

test("timeout kills an agent that ignores cancel and keeps a WIP commit", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = {
    ignoreCancel: true,
    steps: [
      { type: "fs_write", path: join(layout.worktree, "partial.txt"), content: "partial\n" },
      { type: "hang" },
    ],
  };
  const files = await writeScript(layout.root, script);
  const events: AcpEvent[] = [];
  const result = await runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-timeout",
    prompt: "do the work",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: [fakeAgent],
    env: agentEnv(files.resultPath, files.scriptPath),
    timeoutMs: 400,
    cancelGraceMs: 200,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(result.timedOut).toBe(true);
  expect(events.filter((event) => event.type === "cancelled")).toEqual([
    { type: "cancelled", reason: "timeout" },
  ]);
  expect(result.agentExited).toBe(true);
  expect(result.pid).toBeDefined();
  expect(alive(result.pid)).toBe(false);
  expect(result.checkpoint?.committed).toBe(true);
  expect(await readFile(join(layout.worktree, "partial.txt"), "utf8")).toBe("partial\n");
  const subject = (await git(["-C", layout.worktree, "log", "-1", "--format=%s"])).trim();
  expect(subject).toContain("wip:");
}, 20_000);

test("cancel leaves no agent process", async () => {
  const layout = await layoutRepo();
  const script: FakeScript = { steps: [{ type: "hang" }] };
  const files = await writeScript(layout.root, script);
  const controller = new AbortController();
  const running = runAgent({
    role: "implementer",
    itemId: "ENG-1",
    runId: "run-cancel",
    prompt: "stop me",
    worktreePath: layout.worktree,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    command: process.execPath,
    args: [fakeAgent],
    env: agentEnv(files.resultPath, files.scriptPath),
    timeoutMs: 10_000,
    cancelGraceMs: 1_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);
  const result = await running;
  expect(result.cancelled).toBe(true);
  expect(result.agentExited).toBe(true);
  expect(alive(result.pid)).toBe(false);
}, 20_000);

function alive(pid: number | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outcome(trace: FakeResult, toolCallId: string): string | undefined {
  const entry = trace.permissions.find((permission) => permission.toolCallId === toolCallId);
  const outcomeValue = entry?.outcome as
    | { outcome?: { outcome?: string; optionId?: string } }
    | undefined;
  return outcomeValue?.outcome?.optionId;
}

async function layoutRepo(): Promise<{
  root: string;
  source: string;
  home: string;
  pawsRoot: string;
  worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "paws-acp-"));
  roots.push(root);
  const source = join(root, "checkout");
  const home = join(root, "home");
  const pawsRoot = join(home, ".paws");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await mkdir(join(home, "Library", "Keychains"), { recursive: true });
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(["-C", source, "add", "README.md"]);
  await git([
    "-C",
    source,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "init",
  ]);
  const { ensureBareMirror, createWorktree } = await import("./worktree");
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });
  const worktree = await createWorktree({ owner: "acme", repo: "demo", itemId: "ENG-1", pawsRoot });
  return { root, source, home, pawsRoot, worktree: worktree.path };
}

async function writeScript(
  root: string,
  script: FakeScript,
): Promise<{ scriptPath: string; resultPath: string }> {
  const scriptPath = join(root, "fake-script.json");
  const resultPath = join(root, "fake-result.json");
  await writeFile(scriptPath, JSON.stringify(script));
  return { scriptPath, resultPath };
}

function agentEnv(resultPath: string, scriptPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FAKE_ACP_RESULT: resultPath,
    FAKE_ACP_SCRIPT: scriptPath,
    GH_TOKEN: "should-not-pass",
    SSH_AUTH_SOCK: "/tmp/agent-sock",
  };
}

async function readResult(path: string): Promise<FakeResult> {
  return JSON.parse(await readFile(path, "utf8")) as FakeResult;
}
