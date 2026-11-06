import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createDirectWorkerSupervisor,
  createRunnerResultDirectory,
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerJob,
  RUNNER_SKILLS_ENV,
  workerSpawn,
  type RunnerJob,
  type RunnerSystemctl,
} from "../src/runner-execution";
import { RunnerCliFailure, workerAgentUser } from "../src/runner-cli";

const roots: string[] = [];
const pids: number[] = [];
const id = "01K00000000000000000000000";
const unit = `paws-agent@${id}.service`;
const skillsPath = "/var/lib/paws-runner/skills/sets/01K00000000000000000000001";

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2)[0]!);
  } catch {
    return false;
  }
}

function fakeSystemctl(fail?: string, exitsAtOnce = false, showFails = false) {
  const calls: string[][] = [];
  let pid: number | undefined;
  const systemctl: RunnerSystemctl = async (args) => {
    calls.push([...args]);
    if (args[0] === "start") {
      if (fail) return { code: 1, output: fail };
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      pid = child.pid!;
      pids.push(pid);
      return { code: 0, output: "" };
    }
    if (args[0] === "show")
      return showFails
        ? { code: 1, output: "Failed to connect to bus" }
        : { code: 0, output: `${exitsAtOnce ? 0 : (pid ?? 0)}\n` };
    if (args[0] === "stop") {
      const main = pid;
      if (main !== undefined && running(main)) {
        process.kill(main, "SIGKILL");
        for (let wait = 0; wait < 500 && running(main); wait++)
          await new Promise((r) => setTimeout(r, 10));
      }
      return { code: 0, output: "" };
    }
    return { code: 1, output: "unexpected" };
  };
  return { calls, systemctl };
}

function prepared(root: string, account?: RunnerJob["command"]["account"]) {
  const spoolRoot = join(root, "spool");
  mkdirSync(spoolRoot, { mode: 0o750 });
  chmodSync(spoolRoot, 0o750);
  const resultsRoot = join(root, "results");
  mkdirSync(resultsRoot, { mode: 0o770 });
  chmodSync(resultsRoot, 0o770);
  const spool = { root: spoolRoot, runnerUid: process.getuid!(), agentGid: process.getgid!() };
  publishRunnerJob(spool, {
    executionId: id,
    command: {
      id: "cmd",
      runnerId: "runner",
      workspaceId: "ws",
      issuedAt: 1,
      expiresAt: 2,
      type: "probe",
      profile: { agent: "codex", model: null },
      ...(account ? { account } : {}),
    },
  });
  return {
    spool,
    results: {
      root: resultsRoot,
      runnerUid: process.getuid!(),
      agentUid: process.getuid!(),
      resultsGid: process.getgid!(),
    },
  };
}

function setup(
  agentUser: "runner" | "paws-agent",
  fail?: string,
  shared?: {
    root: string;
    exitsAtOnce?: boolean;
    showFails?: boolean;
    jobs?: ReturnType<typeof prepared>;
    agentHome?: string;
  },
) {
  const root = shared?.root ?? mkdtempSync(join(tmpdir(), "paws-agent-user-"));
  if (!shared) roots.push(root);
  const fake = fakeSystemctl(fail, shared?.exitsAtOnce, shared?.showFails);
  const launched: unknown[][] = [];
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    taskRoot: root,
    agentEnvRoot: root,
    agentUser,
    ...(shared?.jobs ?? {}),
    ...(shared?.agentHome ? { agentHome: shared.agentHome, workRoot: join(root, "work") } : {}),
    systemctl: fake.systemctl,
    skills: { prepareHome() {}, hold: () => skillsPath, release() {} },
    launch(...input) {
      launched.push(input);
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      pids.push(child.pid!);
      return child;
    },
  });
  return { root, fake, launched, supervisor, envFile: join(root, `${id}.env`) };
}

test('"runner" spawns the worker exactly as before', () => {
  const script = process.argv[1];
  process.argv[1] = "/opt/paws-runner/current/src/runner-cli/main.ts";
  try {
    const [command, args, options] = workerSpawn(
      id,
      "/var/lib/paws-agent",
      7,
      true,
      { PAWS_EXECUTION_ID: `scope/${id}` },
      skillsPath,
    );
    const user = Object.fromEntries(
      (["USER", "LOGNAME"] as const).flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    expect({ command, args, options }).toEqual({
      command: process.execPath,
      args: [
        ...process.execArgv,
        "/opt/paws-runner/current/src/runner-cli/main.ts",
        "runner",
        "worker",
        "--execution-id",
        id,
        "--resume",
      ],
      options: {
        cwd: "/var/lib/paws-agent",
        detached: true,
        stdio: ["ignore", 7, 7],
        env: {
          HOME: "/var/lib/paws-agent",
          PATH: "/opt/paws-runner/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          ...(existsSync("/run/paws-docker/docker.sock")
            ? { DOCKER_HOST: "unix:///run/paws-docker/docker.sock" }
            : {}),
          PAWS_EXECUTION_ID: `scope/${id}`,
          [RUNNER_SKILLS_ENV]: skillsPath,
          ...user,
        },
      },
    });
  } finally {
    process.argv[1] = script!;
  }
});

test('"runner" launches and stops directly and never calls systemctl', async () => {
  const { fake, launched, supervisor, envFile } = setup("runner");
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(launched).toHaveLength(1);
  expect(launched[0]!.slice(0, 2)).toEqual([id, process.env.HOME ?? "/var/lib/paws-agent"]);
  expect(launched[0]![3]).toBe(false);
  expect(launched[0]![5]).toBe(skillsPath);
  expect(supervisor.alive!(id)).toBe(true);
  await supervisor.stop(id);
  expect(supervisor.alive!(id)).toBe(false);
  expect(fake.calls).toEqual([]);
  expect(existsSync(envFile)).toBe(false);
});

test('"paws-agent" starts the unit with an environment file and stops it through systemctl', async () => {
  const { root, fake, launched, supervisor, envFile } = setup("paws-agent");
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(launched).toEqual([]);
  expect(fake.calls).toEqual([
    ["start", unit],
    ["show", "--property=MainPID", "--value", unit],
  ]);
  expect(statSync(envFile).mode & 0o7777).toBe(0o640);
  const lines = readFileSync(envFile, "utf8").trimEnd().split("\n");
  expect(lines[0]).toBe("PAWS_RESUME=");
  expect(lines[1]).toBe(`${RUNNER_SKILLS_ENV}=${skillsPath}`);
  expect(lines[2]).toMatch(new RegExp(`^PAWS_[A-Z_]+=[0-9a-f]{16}/${id}$`));
  expect(lines.slice(3)).toEqual(
    existsSync("/run/paws-docker/docker.sock")
      ? ["DOCKER_HOST=unix:///run/paws-docker/docker.sock"]
      : [],
  );
  expect(supervisor.alive!(id)).toBe(true);
  writeFileSync(join(root, `${id}.log`), "worker says hello\n", { flag: "a" });
  expect(supervisor.log!(id)).toContain("worker says hello");

  await supervisor.stop(id);
  expect(fake.calls.at(-1)).toEqual(["stop", unit]);
  expect(supervisor.alive!(id)).toBe(false);
  expect(existsSync(envFile)).toBe(false);

  await supervisor.resume!(id);
  expect(readFileSync(envFile, "utf8")).toStartWith("PAWS_RESUME=--resume\n");
  await supervisor.stop(id);
  expect(existsSync(envFile)).toBe(false);
  expect(launched).toEqual([]);
});

test("a failing systemctl start fails the run naming the setting, without a direct spawn", async () => {
  const { fake, launched, supervisor, envFile } = setup(
    "paws-agent",
    `Failed to start ${unit}: Access denied\nSee system logs.`,
  );
  const failure = await supervisor.start(id).then(
    () => null,
    (error: Error) => error.message,
  );
  expect(failure).toContain(`could not start ${unit}: Failed to start ${unit}: Access denied.`);
  expect(failure).toContain('agentUser is "paws-agent" in /etc/paws-runner/config.json');
  expect(launched).toEqual([]);
  expect(fake.calls).toEqual([["start", unit]]);
  expect(existsSync(envFile)).toBe(false);
  expect(supervisor.alive!(id)).toBe(false);
  await supervisor.stop(id);
  expect(fake.calls).toEqual([["start", unit]]);
});

test("the worker refuses any uid but paws-agent's with \"paws-agent\", and keeps today's check otherwise", () => {
  const ids = { runnerUid: 990, pawsAgentUid: 991 };
  expect(workerAgentUser("paws-agent", 991, ids)).toBe("paws-agent");
  expect(workerAgentUser(undefined, 990, ids)).toBe("runner");
  expect(workerAgentUser("runner", 990, ids)).toBe("runner");
  for (const [value, uid] of [
    ["paws-agent", 990],
    ["paws-agent", 0],
    [undefined, 991],
    ["root", 990],
  ] as const)
    expect(() => workerAgentUser(value, uid, ids)).toThrow(RunnerCliFailure);
});

test("an execution keeps the user it was admitted as when agentUser changes", async () => {
  const before = setup("runner");
  expect(await before.supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  await before.supervisor.stop(id);
  const after = setup("paws-agent", undefined, { root: before.root });
  await after.supervisor.resume!(id);
  expect(after.fake.calls).toEqual([]);
  expect(after.launched).toHaveLength(1);
  expect(after.launched[0]![3]).toBe(true);
  await after.supervisor.stop(id);
  expect(after.fake.calls).toEqual([]);
});

test("a paws-agent worker that already exited when systemd is asked keeps its admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-user-"));
  roots.push(root);
  const { fake, launched, supervisor } = setup("paws-agent", undefined, {
    root,
    exitsAtOnce: true,
  });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(launched).toEqual([]);
  expect(fake.calls.map((call) => call[0])).toEqual(["start", "show"]);
  expect(supervisor.alive!(id)).toBe(false);
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: true });
});

test("a failed MainPID query after the worker persisted its result keeps the admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-user-"));
  roots.push(root);
  const jobs = prepared(root);
  const directory = createRunnerResultDirectory(jobs.results, id);
  writeFileSync(join(directory, "result.json"), "{}", { mode: 0o640 });
  chmodSync(join(directory, "result.json"), 0o640);
  const { fake, supervisor } = setup("paws-agent", undefined, { root, showFails: true, jobs });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(fake.calls.map((call) => call[0])).toEqual(["start", "show"]);
  expect(supervisor.alive!(id)).toBe(false);
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: true });
});

test("a failed MainPID query with no result stops the unit and fails the launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-user-"));
  roots.push(root);
  const jobs = prepared(root);
  const { fake, supervisor } = setup("paws-agent", undefined, { root, showFails: true, jobs });
  await expect(supervisor.start(id)).rejects.toThrow("Runner worker did not start");
  expect(fake.calls.map((call) => call[0])).toEqual(["start", "show", "stop"]);
});

test("an account-bound paws-agent run shares the agent home's mise folders and keeps the binding 0640", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-user-"));
  roots.push(root);
  const account = {
    accountId: "01JACCOUNTA000000000000000",
    bindingId: "01JBINDINGA000000000000000",
  };
  const jobs = prepared(root, account);
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  for (const folder of [".cache/mise", ".local/share/mise"])
    mkdirSync(join(agentHome, folder), { recursive: true, mode: 0o700 });
  for (const folder of [".cache", ".cache/mise", ".local", ".local/share", ".local/share/mise"])
    chmodSync(join(agentHome, folder), 0o700);
  const bindingHome = openRunnerAccountHome(agentHome, account, "codex", { signIn: true });
  markRunnerAccountSignedIn(bindingHome, account, "codex");
  const { fake, supervisor } = setup("paws-agent", undefined, { root, jobs, agentHome });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(fake.calls.map((call) => call[0])).toEqual(["start", "show"]);
  const mode = (path: string) => statSync(path).mode & 0o777;
  expect([
    mode(join(agentHome, ".cache/mise")),
    mode(join(agentHome, ".local/share/mise")),
  ]).toEqual([0o770, 0o770]);
  expect(mode(join(bindingHome, "account.json"))).toBe(0o640);
  await supervisor.stop(id);
});
