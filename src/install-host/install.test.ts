import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntime, parseConfigToml, setConfigKeys } from "../config";
import {
  fakePrompt,
  fakeSystemctl,
  MISE_BUN_COMMAND,
  parseInstallArgs,
  runInstall,
  type InstallHostDeps,
  type Prompt,
} from ".";

const BUN = { version: "1.4.2", path: "/opt/bun/bin/bun" };
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "paws-install-host-"));
  homes.push(home);
  return home;
}

function deps(home: string, prompt: Prompt | null, out: string[] = []) {
  const systemctl = fakeSystemctl();
  const value: InstallHostDeps = {
    home,
    env: {},
    prompt,
    findBun: async () => BUN,
    systemctl,
    out: (line) => out.push(line),
  };
  return { deps: value, systemctl, out };
}

const FIRST = [
  "", // checkout
  "", // PAWS_HOME
  "0.0.0.0",
  "443",
  "", // dashboard: yes
  "https://agentbox.example.ts.net",
  "", // runner host: from the public URL
  "", // runner port: 8788
  "PAS",
  "pmdroid/paws-app, pmdroid/agentbox",
  "", // member_vm cpu: exe.dev's default
  "", // member_vm memory
  "", // member_vm disk
  "", // member_vm image
];

function files(home: string) {
  const read = (path: string) =>
    existsSync(join(home, path)) ? readFileSync(join(home, path), "utf8") : "";
  return {
    env: read(".paws/https.env"),
    config: read(".paws/config.toml"),
    unit: read(".config/systemd/user/paws.service"),
    dropIn: read(".config/systemd/user/paws.service.d/working-directory.conf"),
  };
}

describe("paws install", () => {
  test("a first install writes the env file, config and unit", async () => {
    const home = tempHome();
    const prompt = fakePrompt(FIRST);
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);

    const written = files(home);
    expect(written.env).toBe(
      [
        `PAWS_HOME=${home}/.paws`,
        "PAWS_HOST=0.0.0.0",
        "PAWS_PORT=443",
        "PAWS_PUBLIC_URL=https://agentbox.example.ts.net",
        "PAWS_PUBLIC_DASHBOARD=1",
        "PAWS_RUNNER_HOST=agentbox.example.ts.net",
        "PAWS_RUNNER_PORT=8788",
        "",
      ].join("\n"),
    );
    expect(statSync(join(home, ".paws/https.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".paws/config.toml")).mode & 0o777).toBe(0o600);
    const config = parseConfigToml(written.config);
    expect(config.linearTeam).toBe("PAS");
    expect(config.repo).toBe("pmdroid/paws-app");
    expect(config.githubRepos).toEqual(["pmdroid/agentbox"]);
    expect(written.unit).toContain(`EnvironmentFile=${home}/.paws/https.env`);
    expect(written.unit).toContain(
      "ExecStart=/opt/bun/bin/bun --no-env-file src/index.ts --no-tunnel",
    );
    expect(written.unit).toContain("RestartForceExitStatus=75");
    expect(written.unit).toContain("WantedBy=default.target");
    expect(written.dropIn).toBe(`[Service]\nWorkingDirectory=${home}/.local/share/paws/app\n`);
    expect(run.systemctl.calls).toEqual([["--user", "daemon-reload"]]);
    expect(prompt.questions[0]).toBe("Paws checkout path");

    const runtime = loadRuntime(parseEnv(written.env));
    expect(runtime.configError).toBeNull();
    expect(runtime.env.port).toBe(443);
    expect(runtime.repo).toBe("pmdroid/paws-app");
  });

  test("a re-run keeps unchanged values and unrelated config.toml keys", async () => {
    const home = tempHome();
    await runInstall(parseInstallArgs([]), deps(home, fakePrompt(FIRST)).deps);
    const configPath = join(home, ".paws/config.toml");
    const envPath = join(home, ".paws/https.env");
    writeFileSync(
      configPath,
      setConfigKeys(
        `# mine\n${readFileSync(configPath, "utf8")}\n[merge]\norder = "ci-green"\n`,
        "linear",
        { team_id: "team-uuid" },
      ),
    );
    writeFileSync(envPath, `${readFileSync(envPath, "utf8")}PAWS_TLS_CERT_PATH=/tls.crt\n`);
    const before = files(home);

    const prompt = fakePrompt(Array.from({ length: 14 }, () => ""));
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(files(home)).toEqual(before);
    expect(run.out).toContain("Nothing changed.");

    const rerun = fakePrompt(["", "", "", "8443", "", "", "", "", "", "-", "", "", "", ""]);
    expect(await runInstall(parseInstallArgs([]), deps(home, rerun).deps)).toBe(0);
    const after = files(home);
    expect(after.env).toContain("PAWS_PORT=8443\n");
    expect(after.env).toContain("PAWS_TLS_CERT_PATH=/tls.crt\n");
    expect(after.env).toContain("PAWS_HOST=0.0.0.0\n");
    expect(after.config.startsWith("# mine\n")).toBe(true);
    const config = parseConfigToml(after.config);
    expect(config.linearTeamId).toBe("team-uuid");
    expect(config.linearTeam).toBe("PAS");
    expect(config.mergeOrder).toBe("ci-green");
    expect(config.repo).toBeNull();
    expect(config.githubRepos).toEqual([]);
  });

  test("an invalid port or URL is asked again", async () => {
    const home = tempHome();
    const prompt = fakePrompt([
      "",
      "",
      "",
      "70000",
      "eighty",
      "8787",
      "",
      "ftp://paws.example.com",
      "https://paws.example.com/path",
      "https://paws.example.com",
      "-",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(prompt.questions.filter((q) => q === "PAWS_PORT")).toHaveLength(3);
    expect(prompt.questions.filter((q) => q.startsWith("PAWS_PUBLIC_URL"))).toHaveLength(3);
    expect(prompt.questions.some((q) => q.startsWith("PAWS_RUNNER_PORT"))).toBe(false);
    expect(run.out.filter((line) => line.startsWith("  "))).toHaveLength(4);
    const env = files(home).env;
    expect(env).toContain("PAWS_PORT=8787\n");
    expect(env).toContain("PAWS_PUBLIC_URL=https://paws.example.com\n");
    expect(env).not.toContain("PAWS_RUNNER_HOST");
    expect(existsSync(join(home, ".paws/config.toml"))).toBe(false);
  });

  test("--non-interactive with an answers file writes the same files", async () => {
    const interactive = tempHome();
    await runInstall(parseInstallArgs([]), deps(interactive, fakePrompt(FIRST)).deps);

    const scripted = tempHome();
    const answers = join(scripted, "answers.toml");
    writeFileSync(
      answers,
      [
        'paws_host = "0.0.0.0"',
        "paws_port = 8080",
        "paws_public_dashboard = true",
        'paws_public_url = "https://agentbox.example.ts.net"',
        'linear_team = "PAS"',
        'github_repos = ["pmdroid/paws-app", "pmdroid/agentbox"]',
      ].join("\n"),
    );
    const run = deps(scripted, null);
    const args = parseInstallArgs(["--non-interactive", "--answers", answers, "--paws-port=443"]);
    expect(await runInstall(args, run.deps)).toBe(0);
    const swap = (text: string) => text.replaceAll(scripted, interactive);
    const expected = files(interactive);
    const actual = files(scripted);
    expect(swap(actual.env)).toBe(expected.env);
    expect(swap(actual.config)).toBe(expected.config);
    expect(swap(actual.unit)).toBe(expected.unit);
    expect(swap(actual.dropIn)).toBe(expected.dropIn);
  });

  test("the exe.dev VM size is asked, re-asked when invalid, kept on a re-run and cleared with -", async () => {
    const home = tempHome();
    const prompt = fakePrompt([
      ...FIRST.slice(0, 10),
      "-2",
      "eight",
      "8",
      "16",
      "100",
      "ubuntu 24.04",
      "ubuntu:24.04",
    ]);
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(prompt.questions.filter((q) => q.startsWith("exe.dev runner VM CPUs"))).toHaveLength(3);
    expect(prompt.questions.filter((q) => q.startsWith("exe.dev runner VM image"))).toHaveLength(2);
    expect(run.out).toContain("  member_vm.cpu must be a whole number from 1 to 512");
    const written = parseConfigToml(files(home).config).memberVm;
    expect(written).toEqual({ cpu: 8, memoryGb: 16, diskGb: 100, image: "ubuntu:24.04" });
    expect(files(home).config).toContain("[member_vm]\ncpu = 8\n");

    const keep = fakePrompt(Array.from({ length: 14 }, () => ""));
    const kept = deps(home, keep);
    expect(await runInstall(parseInstallArgs([]), kept.deps)).toBe(0);
    expect(kept.out).toContain("Nothing changed.");

    const clear = fakePrompt([...FIRST.slice(0, 10).map(() => ""), "-", "", "-", "-"]);
    expect(await runInstall(parseInstallArgs([]), deps(home, clear).deps)).toBe(0);
    expect(parseConfigToml(files(home).config).memberVm).toEqual({ memoryGb: 16 });
  });

  test("an answers file sets the exe.dev VM size and rejects an invalid one", async () => {
    const home = tempHome();
    const answers = join(home, "answers.toml");
    writeFileSync(
      answers,
      [
        'paws_public_url = "https://paws.example.com"',
        "member_vm_cpu = 4",
        "member_vm_memory_gb = 8",
      ].join("\n"),
    );
    const args = parseInstallArgs(["--non-interactive", "--answers", answers]);
    expect(await runInstall(args, deps(home, null).deps)).toBe(0);
    expect(parseConfigToml(files(home).config).memberVm).toEqual({ cpu: 4, memoryGb: 8 });

    const bad = parseInstallArgs([
      "--non-interactive",
      "--answers",
      answers,
      "--member-vm-disk-gb",
      "0",
    ]);
    await expect(runInstall(bad, deps(tempHome(), null).deps)).rejects.toThrow(
      "member_vm_disk_gb: member_vm.disk_gb must be a whole number",
    );
  });

  test("--non-interactive rejects an invalid value instead of asking", async () => {
    const home = tempHome();
    const args = parseInstallArgs(["--non-interactive", "--paws-public-url", "not a url"]);
    await expect(runInstall(args, deps(home, null).deps)).rejects.toThrow("paws_public_url");
  });

  test("a missing or wrong bun prints the mise command and stops", async () => {
    const home = tempHome();
    const run = deps(home, fakePrompt([]));
    run.deps.findBun = async () => ({ version: "1.3.0", path: "/usr/bin/bun" });
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(1);
    expect(run.out.join("\n")).toContain(MISE_BUN_COMMAND);
    run.deps.findBun = async () => null;
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(1);
    expect(run.systemctl.calls).toEqual([]);
  });
});

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string]),
  );
}
