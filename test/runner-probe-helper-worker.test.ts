import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const userEnv = { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` };
const sandbox =
  spawnSync(
    "/usr/bin/systemd-run",
    ["--user", "-q", "--pipe", "--wait", "-p", "PrivateTmp=yes", "true"],
    {
      env: userEnv,
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
const write: Helper = {
  ...base,
  sessionId: "probes-write",
  purpose: "probe_write",
  prompt: "Write the probe for no-raw-sql.",
  probe: { repository: "acme/web", path: ".agents/probes/no-raw-sql.ts" },
  repositories: ["acme/web"],
};
const distill: Helper = { ...base, sessionId: "d", purpose: "probe_distill", prompt: "Distill." };
const PROBE = ".agents/probes/no-raw-sql.ts";

const LAUNCHER = `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
while [ "$1" != "--" ]; do
  case "$1" in EnvironmentFile=*) env="\${1#*=}" ;; --working-directory=*) cd "\${1#*=}" ;; esac
  shift
done
shift
set -a; . "$env"; set +a
exec "$@"
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

async function run(
  command: Helper,
  steps: (checkout: string) => unknown[],
  { real = false, stale = false } = {},
) {
  const root = mkdtempSync(join(real ? homedir() : tmpdir(), ".paws-probe-helper-"));
  roots.push(root);
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  const accountHome = runnerAccountHome(agentHome, account);
  signInRunnerAccount(agentHome, "codex", account);
  const origin = join(root, "origin");
  mkdirSync(join(origin, "src"), { recursive: true });
  writeFileSync(join(origin, "src", "index.ts"), "export {};\n");
  git(origin, "init", "-q", "-b", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "first");
  const commit = git(origin, "rev-parse", "HEAD");
  if (stale) git(origin, "commit", "-qm", "second", "--allow-empty");
  git(root, "clone", "-q", "--bare", origin, join(root, "mirror.git"));
  const checkout = join(root, "work", executionId, "repositories", "acme", "web");
  const [script, recorded, launcher] = [
    join(root, "script.json"),
    join(accountHome, "agent.json"),
    join(root, "systemd-run"),
  ];
  writeFileSync(launcher, LAUNCHER);
  chmodSync(launcher, 0o755);
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
      ...(real ? {} : { sandboxLauncher: launcher }),
    },
  });
  const calls = existsSync(recorded) ? JSON.parse(readFileSync(recorded, "utf8")) : {};
  const launched = real ? [] : readFileSync(`${launcher}.args`, "utf8").split("\n");
  return { result, calls, accountHome, checkout, launched };
}

const reply = (text: string) => ({
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const put = (path: string) => ({ type: "fs_write", path, content: "x" });
const file = (path: string) => ({ type: "write_file", path, content: "x" });
const end = { type: "end" };

test("probe_write runs in a unit writable only under .agents/probes and returns the probe and its entry", async () => {
  const entry = '```json\n{"failOn":"P1"}\n```';
  const { result, calls, accountHome, checkout, launched } = await run(write, (folder) => [
    {
      type: "permission",
      toolCall: { toolCallId: "e", kind: "edit", locations: [{ path: PROBE }] },
    },
    put(PROBE),
    put("src/index.ts"),
    put(join(folder, "../../../outside.txt")),
    { type: "terminal", command: "touch", args: ["src/x"] },
    reply(entry),
    end,
  ]);
  expect(calls.permissions[0].outcome.outcome.optionId).toBe("allow");
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([true, false, false]);
  expect(calls.mcpServers).toEqual([]);
  expect(result.probe).toEqual({ path: PROBE, text: "x", entry: { failOn: "P1" } });
  const probes = `ReadWritePaths=${join(checkout, ".agents", "probes")}`;
  expect(launched).toEqual(
    expect.arrayContaining(["--user", "ProtectSystem=strict", "ProtectHome=read-only"]),
  );
  expect(launched).toEqual(expect.arrayContaining(["PrivateTmp=yes", probes]));
  expect(launched).toContain(`ReadWritePaths=${accountHome}`);
  expect(launched.filter((arg) => arg.startsWith(`ReadWritePaths=${checkout}`))).toEqual([probes]);
  expect(readFileSync(join(checkout, "src", "index.ts"), "utf8")).toBe("export {};\n");
  expect(existsSync(join(checkout, "src", "x"))).toBe(false);
}, 15_000);

test("probe_write fails on a missing probe, a change outside .agents/probes or a bad entry", async () => {
  for (const [path, text, error] of [
    [".agents/probes/other.ts", '{"failOn":"P1"}', `The agent did not write ${PROBE}`],
    [
      "src/index.ts",
      '{"failOn":"P1"}',
      "The agent changed files outside .agents/probes/: src/index.ts",
    ],
    [PROBE, '{"failOn":"P9"}', "The agent did not propose a valid rules entry"],
    [PROBE, "no entry", "The agent did not propose a valid rules entry"],
  ]) {
    const { result } = await run(write, (folder) => [file(join(folder, path!)), reply(text!), end]);
    expect(result).toMatchObject({ run: { stopReason: "error", errorMessage: error } });
    expect(result.probe).toBeUndefined();
  }
}, 20_000);

test("probe_write refuses a checkout whose HEAD is not the fetched origin/main", async () => {
  await expect(run(write, () => [end], { stale: true })).rejects.toThrow(
    "The probe's checkout is not at the fetched origin/main commit",
  );
});

test("probe_distill answers as text and its edits are refused", async () => {
  const { result, calls } = await run(distill, () => [put("note.txt"), reply("{}"), end]);
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
  expect(result.text).toBe("{}");
}, 15_000);

test.skipIf(!sandbox)(
  "a sandboxed probe_distill turn cannot write into its worktree",
  async () => {
    const { result, checkout } = await run(
      distill,
      (folder) => [file(join(folder, "../../n")), end],
      {
        real: true,
      },
    );
    expect(result.run.errorMessage).toContain("EROFS");
    expect(existsSync(join(checkout, "../../n"))).toBe(false);
  },
  30_000,
);

test.skipIf(!sandbox)(
  "a sandboxed probe_write turn writes only under .agents/probes",
  async () => {
    const kept = await run(
      write,
      (folder) => [file(join(folder, PROBE)), reply('{"failOn":"P2"}'), end],
      {
        real: true,
      },
    );
    expect(kept.result.probe?.entry).toEqual({ failOn: "P2" });
    const refused = await run(
      write,
      (folder) => [file(join(folder, PROBE)), file(join(folder, "src/x"))],
      {
        real: true,
      },
    );
    expect(refused.result.run.errorMessage).toContain("EROFS");
    expect(refused.result.probe).toBeUndefined();
    expect(existsSync(join(refused.checkout, "src/x"))).toBe(false);
  },
  30_000,
);
