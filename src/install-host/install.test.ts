import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { loadRuntime, parseConfigToml, setConfigKeys } from "../config";
import { validatePublicTls, validatePublicTlsFiles } from "../deployment";
import {
  fakePrompt,
  fakeSystemctl,
  fakeTailscale,
  MISE_BUN_COMMAND,
  parseInstallArgs,
  runInstall,
  type InstallHostDeps,
  type Prompt,
  type TlsPaths,
} from ".";

const BUN = { version: "1.4.2", path: "/opt/bun/bin/bun" };
const HOST = "agentbox.example.ts.net";
const homes: string[] = [];
let certs: string;
const cert = (name: string): TlsPaths => ({
  key: join(certs, `${name}.key`),
  cert: join(certs, `${name}.crt`),
});

beforeAll(() => {
  certs = mkdtempSync(join(tmpdir(), "paws-install-certs-"));
  for (const host of [HOST, "other.example.ts.net", "paws.example.com"]) {
    const paths = cert(host);
    const made = Bun.spawnSync(
      [
        "/usr/bin/openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        paths.key,
        "-out",
        paths.cert,
        "-days",
        "2",
        "-subj",
        `/CN=${host}`,
        "-config",
        "/dev/null",
        "-addext",
        `subjectAltName=DNS:${host}`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (made.exitCode !== 0) throw new Error(made.stderr.toString());
    chmodSync(paths.key, 0o600);
  }
});

afterAll(() => rmSync(certs, { recursive: true, force: true }));

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "paws-install-host-"));
  homes.push(home);
  return home;
}

/** A fake `tailscale` in `home/bin` that hands out the certificate for `host`. */
function tailscale(home: string, host = HOST, code = 0): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  return fakeTailscale(bin, cert(host), code);
}

function deps(home: string, prompt: Prompt | null, out: string[] = []) {
  const systemctl = fakeSystemctl();
  const value: InstallHostDeps = {
    home,
    env: {},
    prompt,
    findBun: async () => BUN,
    systemctl,
    tailscale: tailscale(home),
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
  "", // tailscale cert: yes
];

function files(home: string) {
  const read = (path: string) =>
    existsSync(join(home, path)) ? readFileSync(join(home, path), "utf8") : "";
  return {
    env: read(".paws/https.env"),
    config: read(".paws/config.toml"),
    unit: read(".config/systemd/user/paws.service"),
    dropIn: read(".config/systemd/user/paws.service.d/working-directory.conf"),
    renewService: read(".config/systemd/user/paws-tls-renew.service"),
    renewTimer: read(".config/systemd/user/paws-tls-renew.timer"),
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
        `PAWS_TLS_KEY_PATH=${home}/.paws/tls/${HOST}.key`,
        `PAWS_TLS_CERT_PATH=${home}/.paws/tls/${HOST}.crt`,
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
    expect(written.unit).toContain("ExecStart=/opt/bun/bin/bun --no-env-file src/index.ts\n");
    expect(written.unit).toContain("RestartForceExitStatus=75");
    expect(written.unit).toContain("WantedBy=default.target");
    expect(written.dropIn).toBe(`[Service]\nWorkingDirectory=${home}/.local/share/paws/app\n`);
    expect(run.systemctl.calls).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "paws-tls-renew.timer"],
    ]);
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
    writeFileSync(envPath, `${readFileSync(envPath, "utf8")}PAWS_EXECUTION=remote\n`);
    const before = files(home);

    const prompt = fakePrompt(Array.from({ length: 15 }, () => ""));
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(files(home)).toEqual(before);
    expect(run.out).toContain("Nothing changed.");

    const rerun = fakePrompt(["", "", "", "8443", "", "", "", "", "", "-", "", "", "", "", ""]);
    expect(await runInstall(parseInstallArgs([]), deps(home, rerun).deps)).toBe(0);
    const after = files(home);
    expect(after.env).toContain("PAWS_PORT=8443\n");
    expect(after.env).toContain("PAWS_EXECUTION=remote\n");
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
      cert("paws.example.com").key,
      cert("paws.example.com").cert,
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
    expect(swap(actual.renewService)).toBe(expected.renewService);
    expect(swap(actual.renewTimer)).toBe(expected.renewTimer);
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
      "", // tailscale cert: yes
    ]);
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(prompt.questions.filter((q) => q.startsWith("exe.dev runner VM CPUs"))).toHaveLength(3);
    expect(prompt.questions.filter((q) => q.startsWith("exe.dev runner VM image"))).toHaveLength(2);
    expect(run.out).toContain("  member_vm.cpu must be a whole number from 1 to 512");
    const written = parseConfigToml(files(home).config).memberVm;
    expect(written).toEqual({ cpu: 8, memoryGb: 16, diskGb: 100, image: "ubuntu:24.04" });
    expect(files(home).config).toContain("[member_vm]\ncpu = 8\n");

    const keep = fakePrompt(Array.from({ length: 15 }, () => ""));
    const kept = deps(home, keep);
    expect(await runInstall(parseInstallArgs([]), kept.deps)).toBe(0);
    expect(kept.out).toContain("Nothing changed.");

    const clear = fakePrompt([...FIRST.slice(0, 10).map(() => ""), "-", "", "-", "-", ""]);
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
        `tls_key_path = "${cert("paws.example.com").key}"`,
        `tls_cert_path = "${cert("paws.example.com").cert}"`,
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

describe("paws install TLS", () => {
  test("the tailnet path writes the key and certificate and sets the env", async () => {
    const home = tempHome();
    const run = deps(home, fakePrompt(FIRST));
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);

    const key = join(home, ".paws/tls", `${HOST}.key`);
    const crt = join(home, ".paws/tls", `${HOST}.crt`);
    expect(readFileSync(join(home, "bin/calls"), "utf8")).toBe(`${HOST}\n`);
    expect(statSync(join(home, ".paws/tls")).mode & 0o777).toBe(0o700);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(crt).mode & 0o777).toBe(0o644);
    expect(readFileSync(crt, "utf8")).toBe(readFileSync(cert(HOST).cert, "utf8"));
    const env = parseEnv(files(home).env);
    expect(env.PAWS_TLS_KEY_PATH).toBe(key);
    expect(env.PAWS_TLS_CERT_PATH).toBe(crt);
    expect(validatePublicTls(env)).toBeDefined();

    const { renewService, renewTimer } = files(home);
    expect(renewService).toContain(
      `ExecStart=${home}/bin/tailscale cert --cert-file ${crt} --key-file ${key} ${HOST}`,
    );
    expect(renewService).toContain(
      "ExecStartPost=/usr/bin/systemctl --user try-reload-or-restart paws.service",
    );
    expect(renewTimer).toContain("OnCalendar=weekly");
    const out = run.out.join("\n");
    expect(out).toContain("PAWS_RUNNER_PORT 8788 uses the same certificate");
    expect(out).toContain('"dst": ["paws:443,8788"]');
    expect(out).toContain('"ip": ["tcp:443", "tcp:8788"]');
  });

  test("DNS certificates work when the runner binds to an IP address", async () => {
    for (const bind of ["100.101.102.103", "0.0.0.0"]) {
      const home = tempHome();
      const run = deps(home, null);
      expect(
        await runInstall(
          parseInstallArgs([
            "--non-interactive",
            "--paws-public-url",
            `https://${HOST}`,
            "--paws-runner-host",
            bind,
          ]),
          run.deps,
        ),
      ).toBe(0);
      expect(parseEnv(files(home).env).PAWS_RUNNER_HOST).toBe(bind);
    }
  });

  test("supplied certificate paths skip tailscale by default for flags and answers files", async () => {
    for (const viaFile of [false, true]) {
      const home = tempHome();
      const args = ["--non-interactive", "--paws-public-url", `https://${HOST}`];
      if (viaFile) {
        const file = join(home, "answers.toml");
        writeFileSync(
          file,
          `tls_key_path = "${cert(HOST).key}"\ntls_cert_path = "${cert(HOST).cert}"\n`,
        );
        args.push("--answers", file);
      } else args.push("--tls-key-path", cert(HOST).key, "--tls-cert-path", cert(HOST).cert);
      expect(await runInstall(parseInstallArgs(args), deps(home, null).deps)).toBe(0);
      expect(existsSync(join(home, "bin/calls"))).toBe(false);
      expect(parseEnv(files(home).env).PAWS_TLS_KEY_PATH).toBe(cert(HOST).key);
      expect(files(home).renewTimer).toBe("");
    }
  });

  test("switching to supplied certificates or disabling the dashboard removes renewal", async () => {
    for (const dashboardOff of [false, true]) {
      const home = tempHome();
      await runInstall(parseInstallArgs([]), deps(home, fakePrompt(FIRST)).deps);
      const run = deps(home, null);
      const args = dashboardOff
        ? ["--paws-public-dashboard", "no"]
        : ["--tls-key-path", cert(HOST).key, "--tls-cert-path", cert(HOST).cert];
      expect(await runInstall(parseInstallArgs(["--non-interactive", ...args]), run.deps)).toBe(0);
      expect(run.systemctl.calls).toContainEqual([
        "--user",
        "disable",
        "--now",
        "paws-tls-renew.timer",
      ]);
      expect(files(home).renewTimer).toBe("");
      expect(files(home).renewService).toBe("");
    }
  });

  test("TLS validation ignores unrelated runtime settings", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".paws"));
    writeFileSync(join(home, ".paws/config.toml"), "[agent]\nmax_turns = -1\n");
    const source = {
      PAWS_HOME: join(home, ".paws"),
      PAWS_PUBLIC_DASHBOARD: "1",
      PAWS_PUBLIC_URL: `https://${HOST}`,
      PAWS_TLS_KEY_PATH: cert(HOST).key,
      PAWS_TLS_CERT_PATH: cert(HOST).cert,
    };
    expect(() => validatePublicTls(source)).toThrow("configuration is invalid");
    expect(validatePublicTlsFiles(source)).toBeDefined();
    const prompt = fakePrompt(FIRST.slice(0, 2));
    await expect(
      runInstall(parseInstallArgs(["--non-interactive"]), deps(home, prompt).deps),
    ).rejects.toThrow("config.toml:");
    expect(prompt.questions.some((question) => question.startsWith("Run tailscale cert"))).toBe(
      false,
    );
  });

  test("renewal escapes systemd expansion and certificate fetch drains verbose stdout", async () => {
    const home = tempHome();
    const run = deps(home, null);
    const command = run.deps.tailscale!;
    writeFileSync(
      command,
      readFileSync(command, "utf8").replace("shift\n", "shift\nhead -c 1048576 /dev/zero\n"),
    );
    const pawsHome = join(home, "paws%1$USER");
    expect(
      await runInstall(
        parseInstallArgs([
          "--non-interactive",
          "--paws-public-url",
          `https://${HOST}`,
          "--paws-home",
          pawsHome,
          "--paws-runner-host",
          "-",
        ]),
        run.deps,
      ),
    ).toBe(0);
    expect(files(home).renewService).toContain("paws%%1$$USER");
    expect(run.out.join("\n")).not.toContain("tcp:8788");
  });

  test("the timer unit is written once and kept on re-run", async () => {
    const home = tempHome();
    await runInstall(parseInstallArgs([]), deps(home, fakePrompt(FIRST)).deps);
    const timer = join(home, ".config/systemd/user/paws-tls-renew.timer");
    const service = join(home, ".config/systemd/user/paws-tls-renew.service");
    const before = [statSync(timer), statSync(service)].map((stat) => [stat.ino, stat.mtimeMs]);
    const text = readFileSync(timer, "utf8");

    const run = deps(home, fakePrompt(Array.from({ length: 15 }, () => "")));
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(run.out).toContain("Nothing changed.");
    expect([statSync(timer), statSync(service)].map((stat) => [stat.ino, stat.mtimeMs])).toEqual(
      before,
    );
    expect(readFileSync(timer, "utf8")).toBe(text);
    expect(run.systemctl.calls).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "paws-tls-renew.timer"],
    ]);
  });

  test("a certificate for another host is refused and asked again", async () => {
    const home = tempHome();
    const run = deps(home, fakePrompt([...FIRST, "", cert(HOST).key, cert(HOST).cert]));
    run.deps.tailscale = tailscale(home, "other.example.ts.net");
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(run.out).toContain("  Public HTTPS certificate does not match its hostname.");
    const env = parseEnv(files(home).env);
    expect(env.PAWS_TLS_KEY_PATH).toBe(cert(HOST).key);
    expect(files(home).renewTimer).toBe("");

    const scripted = tempHome();
    const scriptedRun = deps(scripted, null);
    scriptedRun.deps.tailscale = tailscale(scripted, "other.example.ts.net");
    const args = parseInstallArgs(["--non-interactive", "--paws-public-url", `https://${HOST}`]);
    await expect(runInstall(args, scriptedRun.deps)).rejects.toThrow(
      "Public HTTPS certificate does not match its hostname.",
    );
    expect(existsSync(join(scripted, ".paws/https.env"))).toBe(false);
  });

  test("a key readable by others is explained and asked again", async () => {
    const home = tempHome();
    const open = join(home, "open.key");
    writeFileSync(open, readFileSync(cert("paws.example.com").key), { mode: 0o644 });
    chmodSync(open, 0o644);
    const answers = [...FIRST.slice(0, 5), "https://paws.example.com", ...FIRST.slice(6, 14)];
    const prompt = fakePrompt([
      ...answers,
      open,
      cert("paws.example.com").cert,
      cert(HOST).key,
      cert(HOST).cert,
      cert("paws.example.com").key,
      cert("paws.example.com").cert,
    ]);
    const run = deps(home, prompt);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    expect(prompt.questions.some((q) => q.startsWith("Run tailscale cert"))).toBe(false);
    expect(run.out).toContain(
      `  Public TLS private key must be an owner-only readable file: chmod 600 ${open}`,
    );
    expect(run.out).toContain("  Public HTTPS certificate does not match its hostname.");
    expect(parseEnv(files(home).env).PAWS_TLS_KEY_PATH).toBe(cert("paws.example.com").key);
  });

  test("a failed tailscale cert says so, prints the commands and asks for paths", async () => {
    const home = tempHome();
    const run = deps(home, fakePrompt([...FIRST, cert(HOST).key, cert(HOST).cert]));
    run.deps.tailscale = tailscale(home, HOST, 1);
    expect(await runInstall(parseInstallArgs([]), run.deps)).toBe(0);
    const out = run.out.join("\n");
    expect(out).toContain(
      `tailscale cert ${HOST} exited 1: certificates are not enabled for this tailnet`,
    );
    expect(out).toContain("HTTPS certificates turned on for the tailnet");
    expect(out).toContain(
      `  tailscale cert --cert-file ${home}/.paws/tls/${HOST}.crt --key-file ${home}/.paws/tls/${HOST}.key ${HOST}`,
    );
    expect(parseEnv(files(home).env).PAWS_TLS_CERT_PATH).toBe(cert(HOST).cert);

    const missing = deps(tempHome(), fakePrompt([...FIRST, cert(HOST).key, cert(HOST).cert]));
    missing.deps.tailscale = null;
    expect(await runInstall(parseInstallArgs([]), missing.deps)).toBe(0);
    expect(missing.out.join("\n")).toContain("The tailscale CLI is not on PATH.");
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
