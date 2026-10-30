import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePrompt, fakeSystemctl, parseInstallArgs, runInstall, type InstallHostDeps } from ".";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "paws-install-final-"));
  homes.push(home);
  const output: string[] = [];
  const systemctl = fakeSystemctl();
  const loginctl = fakeSystemctl();
  const health: string[] = [];
  const doctorEnvs: InstallHostDeps["env"][] = [];
  const deps: InstallHostDeps = {
    home,
    env: {},
    prompt: null,
    findBun: async () => ({ version: "1.4.2", path: "/bin/bun" }),
    systemctl,
    loginctl,
    tailscale: null,
    async doctor(env) {
      doctorEnvs.push(env);
      return [
        { name: "git", ok: true, detail: "installed" },
        {
          name: "linear-workspace",
          ok: false,
          detail: "sign-in needed",
          fix: "Sign in to Linear.",
        },
      ];
    },
    async waitForHealth(url) {
      health.push(url);
      return true;
    },
    out: (line) => output.push(line),
  };
  const args = parseInstallArgs([
    "--non-interactive",
    "--paws-public-dashboard",
    "no",
    "--paws-public-url",
    "https://configured.example.com",
    "--paws-runner-host",
    "runners.example.com",
  ]);
  return { home, deps, args, output, systemctl, loginctl, health, doctorEnvs };
}

test("creates authority once, preserves its signing key and runs doctor with the saved env", async () => {
  const run = setup();
  expect(await runInstall(run.args, run.deps)).toBe(0);
  const root = join(run.home, ".paws/secrets/runner-identity");
  const authority = readFileSync(join(root, "runner-authority.json"), "utf8");
  const signing = readFileSync(join(root, "runner-command-key.pem"), "utf8");
  writeFileSync(join(root, "marker"), "keep");
  expect(await runInstall(run.args, run.deps)).toBe(0);
  expect(readFileSync(join(root, "runner-authority.json"), "utf8")).toBe(authority);
  expect(readFileSync(join(root, "runner-command-key.pem"), "utf8")).toBe(signing);
  expect(existsSync(join(root, "marker"))).toBe(true);
  expect(run.output.filter((line) => line === "Runner authority initialized.")).toHaveLength(1);
  expect(run.doctorEnvs).toHaveLength(2);
  expect(run.doctorEnvs[0]?.PAWS_HOME).toBe(join(run.home, ".paws"));
  expect(run.doctorEnvs[0]?.PAWS_RUNNER_HOST).toBe("runners.example.com");
  expect(run.output.join("\n")).toContain("ok git: installed");
  expect(run.output.join("\n")).toContain("fix: Sign in to Linear.");
});

test("skips authority when no runner host is configured and skips startup without consent", async () => {
  const run = setup();
  run.args.values.paws_runner_host = "-";
  expect(await runInstall(run.args, run.deps)).toBe(0);
  expect(existsSync(join(run.home, ".paws/secrets/runner-identity"))).toBe(false);
  expect(run.systemctl.calls).toEqual([["--user", "daemon-reload"]]);
  expect(run.loginctl.calls).toEqual([]);
  expect(run.health).toEqual([]);
});

test("prints the configured URLs for each next step", async () => {
  const run = setup();
  expect(await runInstall(run.args, run.deps)).toBe(0);
  const output = run.output.join("\n");
  expect(output).toContain("https://configured.example.com/auth/linear/install");
  expect(output).toContain("https://configured.example.com/status/settings/integrations");
  expect(output).toContain("https://configured.example.com/status/runners");
});

test("explicit startup enables linger, starts the service and waits for health", async () => {
  const run = setup();
  run.args.values.start_service = "yes";
  expect(await runInstall(run.args, run.deps)).toBe(0);
  expect(run.loginctl.calls).toEqual([["enable-linger"]]);
  expect(run.systemctl.calls).toEqual([
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", "paws.service"],
  ]);
  expect(run.health).toEqual(["http://127.0.0.1:8787/health"]);
});

test("the interactive startup prompt defaults to no", async () => {
  const run = setup();
  // Supply config values so the only interactive question is startup consent.
  await runInstall(run.args, run.deps);
  const prompt = fakePrompt([""]);
  run.deps.prompt = {
    ask: (question, current) =>
      question.startsWith("Enable and start")
        ? prompt.ask(question, current)
        : Promise.resolve(current),
  };
  expect(await runInstall(run.args, run.deps)).toBe(0);
  expect(prompt.questions).toEqual(["Enable and start paws.service and enable linger (yes/no)"]);
  expect(run.loginctl.calls).toEqual([]);
});

for (const failure of ["linger", "start", "health"] as const) {
  test(`reports ${failure} failure without claiming readiness`, async () => {
    const run = setup();
    run.args.values.start_service = "yes";
    if (failure === "linger") run.deps.loginctl = fakeSystemctl(1);
    if (failure === "start") run.deps.systemctl = async (args) => (args.includes("enable") ? 1 : 0);
    if (failure === "health") run.deps.waitForHealth = async () => false;
    expect(await runInstall(run.args, run.deps)).toBe(1);
    expect(run.output.some((line) => line.startsWith("Paws is healthy"))).toBe(false);
    if (failure !== "health") expect(run.health).toEqual([]);
  });
}
