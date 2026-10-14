import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function probeRunnerControlStartup(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
  const generated = Bun.spawnSync(
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
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: root } },
  );
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  chmodSync(key, 0o600);
  for (const mode of [
    "enabled",
    "disabled",
    "missing",
    "pending",
    "invalid",
    "remote",
    "invalid-execution",
    "transcripts-later",
  ]) {
    const home = join(root, mode);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "test/fixtures/runner-control-startup-process.ts", mode],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          KYOTOAGENT_ROOT: home,
          PAWS_HOME: home,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
          PAWS_PUBLIC_DASHBOARD: "1",
          PAWS_TLS_KEY_PATH: key,
          PAWS_TLS_CERT_PATH: cert,
          LINEAR_MODE: "agent-session",
          LINEAR_CLIENT_ID: "client",
          LINEAR_ACCESS_TOKEN: "fixture-access",
          LINEAR_APP_USER_ID: "app",
          LINEAR_WEBHOOKS: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    );
    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    writeFileSync(join(root, `${mode}.log`), output + errors);
    assert.equal(exit, 0, `${mode}: ${errors}\n${output}`);
    const observations = JSON.parse(output.trim().split("\n").at(-1)!) as {
      name: string;
      passed: boolean;
      observed: unknown;
    }[];
    for (const item of observations) observe(item.name, item.passed, item.observed);
  }
}
