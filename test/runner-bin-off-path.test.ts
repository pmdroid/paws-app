import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { providerCliPath } from "../src/acp";
import { askTeamMcpEntry } from "../src/acp/ask-team";
import { OwnedProcess } from "../src/process";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

/**
 * Tasks no longer have the runner's bin folder on `PATH`, so everything Paws starts from there
 * must start by absolute path. Each process here starts with a `PATH` that finds nothing.
 */
const EMPTY_PATH = "/nonexistent-paws-bin";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-bin-"));
  roots.push(root);
  return root;
}

test("the ask_team MCP server starts on Paws's Bun by absolute path", async () => {
  const entry = askTeamMcpEntry();
  expect(isAbsolute(entry.command)).toBe(true);
  expect(entry.command).toBe(process.execPath);
  const child = Bun.spawn([entry.command, ...entry.args], {
    env: { PATH: EMPTY_PATH, PAWS_ASK_TEAM_SOCKET: join(tempRoot(), "ask.sock") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  await child.stdin.flush();
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  child.stdin.end();
  await child.exited;
  const reply = JSON.parse(text.split("\n")[0]!) as { id: number; result: { serverInfo: unknown } };
  expect(reply.id).toBe(1);
  expect(reply.result.serverInfo).toEqual({ name: "paws-host-tools", version: "0.0.0" });
});

test("an owned helper process starts its anchor on Paws's Bun by absolute path", async () => {
  const child = new OwnedProcess("/bin/sh", ["-c", "echo started"], { PATH: EMPTY_PATH });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.resume();
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  expect(code).toBe(0);
  expect(output.trim()).toBe("started");
  await child.stop(100);
});

test("a runner release runs the claude and codex CLIs from its launchers' absolute paths", () => {
  const base = tempRoot();
  const release = join(base, "releases", "1.2.3");
  mkdirSync(join(release, "node_modules"), { recursive: true });
  mkdirSync(join(base, "bin"));
  for (const name of ["claude", "codex"]) writeFileSync(join(base, "bin", name), "#!/bin/sh\n");
  expect(providerCliPath("claude", release, base)).toBe(join(base, "bin", "claude"));
  expect(providerCliPath("codex", join(base, "current"), base)).toBe(join(base, "bin", "codex"));
  // A checkout keeps the developer's own CLI from their PATH.
  expect(providerCliPath("codex", tempRoot(), base)).toBe("codex");
});

test("a sign-in check and the Codex usage read run the CLI Paws located, not a PATH lookup", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const outputDirectory = join(root, "output");
  for (const path of [home, join(root, "work"), outputDirectory]) mkdirSync(path);
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: [{ type: "hang" }] }));
  const job: RunnerJob = {
    executionId: "01J00000000000000000000004",
    command: {
      id: "check",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      type: "login_check",
      agent: "codex",
    },
  };
  const logins: Array<{ command: string; path: string | undefined }> = [];
  const usage: Array<string | undefined> = [];
  const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
  await executeRunnerCommand({
    job,
    outputDirectory,
    workRoot: join(root, "work"),
    home,
    resultsGid: process.getgid!(),
    launch: { command: process.execPath, args: [fake, join(root, "trace.json"), script] },
    providerCli: (cli) => `/opt/paws-runner/bin/${cli}`,
    loginCommand: async (command, _args, env) => {
      logins.push({ command, path: env.PATH });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async codexRateLimits(env, executable) {
      usage.push(executable);
      expect(env.PATH?.split(":")).not.toContain("/opt/paws-runner/bin");
      return { rateLimits: {} };
    },
  });
  expect(logins.map((login) => login.command)).toEqual(["/opt/paws-runner/bin/codex"]);
  expect(logins[0]!.path?.split(":")).not.toContain("/opt/paws-runner/bin");
  expect(usage).toEqual(["/opt/paws-runner/bin/codex"]);
}, 20_000);
