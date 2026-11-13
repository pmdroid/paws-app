import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExeDevBootstrap, createFakeExeDev, PINNED_TAILSCALE } from "../src/provisioning";
import { detaching, fakeClock } from "./provisioning-detached";

const VM = "ada-paws";
const PAWS = "https://agentbox.taile07e4.ts.net:8787";
const canRunSh = process.platform !== "win32" && existsSync("/bin/sh");
const bin = mkdtempSync(join(tmpdir(), "paws-reach-"));

afterAll(() => rmSync(bin, { recursive: true, force: true }));

function tool(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

tool("getent", '[ "$FAKE_RESOLVES" = 1 ]');
tool("sleep", "exit 0");
tool(
  "curl",
  [
    'out=""; fail=0',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -f*) fail=1 ;; esac; shift; done',
    'if [ "$fail" = 1 ] && [ "$FAKE_STATUS" -ge 400 ]; then exit 22; fi',
    'printf \'%s\' "$FAKE_BODY" > "$out"',
  ].join("\n"),
);

async function reachScript(): Promise<string> {
  const exe = createFakeExeDev();
  exe.addVm(VM);
  exe.scriptExec(VM, /tailscale version/, () => ({
    stdout: `Version=${PINNED_TAILSCALE.amd64.version}\n{"BackendState":"Running"}`,
  }));
  exe.scriptExec(VM, /\/health'/, () => ({}));
  exe.scriptExec(VM, /systemd-resolved|probe\.localhost/, () => ({}));
  await createExeDevBootstrap({
    exeDev: detaching(exe),
    clock: fakeClock(),
    runnerVersion: "1.4.0",
    installer: "#!/bin/sh\n",
    mise: { version: "2026.10.18", sha256: "0".repeat(64) },
    runnerApiUrl: "https://agentbox.taile07e4.ts.net:8788",
    controlPlaneUrl: PAWS,
    serverCa: null,
    tailnet: { authKey: () => "tskey-auth-kAbCdEf1CNTRL-0123", release: PINNED_TAILSCALE.amd64 },
  }).joinTailnet(VM);
  const script = exe.calls
    .flatMap((call) => (call.operation === "execVm" ? [call.command] : []))
    .find((command) => command.includes("/health'"));
  if (!script) throw new Error("no reach command was sent");
  return script;
}

function run(script: string, env: { resolves: boolean; status: number; body: string }) {
  const child = Bun.spawnSync(["/bin/sh", "-c", script], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_RESOLVES: env.resolves ? "1" : "0",
      FAKE_STATUS: String(env.status),
      FAKE_BODY: env.body,
    },
  });
  return { exitCode: child.exitCode, stderr: child.stderr.toString() };
}

const paws = (ok: boolean) =>
  JSON.stringify({ ok, service: "paws", failedChecks: ok ? [] : ["linearWebhook"] });

test.skipIf(!canRunSh)("a healthy Paws answering 200 is reached", async () => {
  expect(run(await reachScript(), { resolves: true, status: 200, body: paws(true) })).toEqual({
    exitCode: 0,
    stderr: "",
  });
});

test.skipIf(!canRunSh)("an unhealthy Paws answering 503 is still reached", async () => {
  expect(run(await reachScript(), { resolves: true, status: 503, body: paws(false) })).toEqual({
    exitCode: 0,
    stderr: "",
  });
});

test.skipIf(!canRunSh)("a proxy's 502 page is not Paws and fails with exit 3", async () => {
  const result = run(await reachScript(), {
    resolves: true,
    status: 502,
    body: "<html><body><h1>502 Bad Gateway</h1></body></html>",
  });
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toBe(`${PAWS}/health did not answer\n`);
});

test.skipIf(!canRunSh)("an unresolvable host fails with exit 2", async () => {
  const result = run(await reachScript(), { resolves: false, status: 200, body: paws(true) });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("cannot resolve agentbox.taile07e4.ts.net\n");
});
