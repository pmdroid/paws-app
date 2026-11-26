import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerAccountHome } from "../src/runner-execution";
import { runnerHelperLifetime, type RunnerCommand } from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";
import { signInRunnerAccount } from "./runner-account-home";

type Helper = Extract<RunnerCommand, { type: "helper" }>;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const account = {
  accountId: "01JACCOUNTA000000000000000",
  bindingId: "01JBINDINGA000000000000000",
};
const executionId = "01J00000000000000000000001";
const sandbox =
  spawnSync(
    "/usr/bin/systemd-run",
    ["--user", "-q", "--pipe", "--wait", "-p", "PrivateTmp=yes", "true"],
    {
      env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` },
    },
  ).status === 0;
const now = Date.now();
const base = {
  id: randomUUID(),
  type: "helper",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: now,
  expiresAt: now + runnerHelperLifetime("probe_write"),
  sessionGeneration: 0,
  profile: { agent: "codex", model: "fixture-model" },
  account,
} as const;
const PROBE = ".agents/probes/no-raw-sql.ts";
const write: Helper = {
  ...base,
  sessionId: "probes-write",
  purpose: "probe_write",
  prompt: "Write the probe for no-raw-sql.",
  probe: { repository: "acme/web", path: PROBE },
  repositories: ["acme/web"],
};
const distill: Helper = { ...base, sessionId: "d", purpose: "probe_distill", prompt: "Distill." };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

async function run(
  command: Helper,
  steps: (checkout: string) => unknown[],
  { stale = false, link = false } = {},
) {
  const root = mkdtempSync(join(homedir(), ".paws-probe-helper-"));
  roots.push(root);
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  signInRunnerAccount(agentHome, "codex", account);
  const origin = join(root, "origin");
  mkdirSync(join(origin, "src"), { recursive: true });
  writeFileSync(join(origin, "src", "index.ts"), "export {};\n");
  if (link) symlinkSync(root, join(origin, ".agents"));
  git(origin, "init", "-q", "-b", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "first");
  const commit = git(origin, "rev-parse", "HEAD");
  if (stale) git(origin, "commit", "-qm", "second", "--allow-empty");
  git(root, "clone", "-q", "--bare", origin, join(root, "mirror.git"));
  const checkout = join(root, "work", executionId, "repositories", "acme", "web");
  const sessions = join(runnerAccountHome(agentHome, account), ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  const [script, recorded] = [join(root, "script.json"), join(sessions, "agent.json")];
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: steps(checkout) }));
  mkdirSync(join(root, "output"));
  const result = await executeRunnerCommand({
    job: { executionId, command },
    outputDirectory: join(root, "output"),
    workRoot: join(root, "work"),
    home: agentHome,
    resultsGid: process.getgid!(),
    helperRepositories: () => [{ repository: "acme/web", commit, path: join(root, "mirror.git") }],
    launch: {
      command: process.execPath,
      args: [
        "--no-env-file",
        fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
        recorded,
        script,
      ],
      env: { PATH: "/usr/bin:/bin" },
    },
  });
  const glob = new Bun.Glob(".paws/runs/*/sessions/agent.json");
  const turn = [...glob.scanSync({ cwd: join(root, "work"), dot: true })][0];
  const calls = turn ? JSON.parse(readFileSync(join(root, "work", turn), "utf8")) : {};
  expect(existsSync(recorded)).toBe(false);
  return { result, calls, checkout, agentHome };
}

const reply = (text: string) => ({
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const file = (path: string) => ({ type: "write_file", path, content: "x" });
const end = { type: "end" };

test("probe_write refuses a checkout whose HEAD is not the fetched origin/main", async () => {
  await expect(run(write, () => [end], { stale: true })).rejects.toThrow(
    "The probe's checkout is not at the fetched origin/main commit",
  );
});

test.skipIf(!sandbox)(
  "a sandboxed probe_write turn writes only under .agents/probes",
  async () => {
    const kept = await run(write, (folder) => [
      { type: "fs_write", path: "src/index.ts", content: "x" },
      file(join(folder, PROBE)),
      reply('```json\n{"failOn":"P1"}\n```'),
      end,
    ]);
    expect(kept.calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
    expect(kept.result.probe).toEqual({ path: PROBE, text: "x", entry: { failOn: "P1" } });
    const invalid = await run(write, (f) => [file(join(f, PROBE)), reply('{"failOn":"P9"}'), end]);
    expect(invalid.result.run.errorMessage).toBe("The agent did not propose a valid rules entry");
    const home = (folder: string) =>
      runnerAccountHome(join(folder, "../../../../../agent"), account);
    for (const outside of [
      "src/x",
      "../../../outside",
      (folder: string) => join(home(folder), "x"),
    ]) {
      const at = (folder: string) =>
        typeof outside === "string" ? join(folder, outside) : outside(folder);
      const refused = await run(write, (folder) => [file(join(folder, PROBE)), file(at(folder))]);
      expect(refused.result.run.errorMessage).toContain("EROFS");
      expect(refused.result.probe).toBeUndefined();
      expect(existsSync(at(refused.checkout))).toBe(false);
    }
  },
  60_000,
);

test.skipIf(!sandbox)(
  "a sandboxed probe_distill turn cannot write into its worktree",
  async () => {
    const { result, checkout } = await run(distill, (folder) => [
      file(join(folder, "../../n")),
      end,
    ]);
    expect(result.run.errorMessage).toContain("EROFS");
    expect(existsSync(join(checkout, "../../n"))).toBe(false);
  },
  30_000,
);

test("a probe_write checkout whose .agents is a link is refused before the agent starts", async () => {
  await expect(run(write, () => [end], { link: true })).rejects.toThrow(
    "A sandbox path is not a plain directory",
  );
});
