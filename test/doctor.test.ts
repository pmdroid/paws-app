import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorChecks, formatDoctor, type DoctorProbe } from "../src/doctor";

const NAMES = [
  "git",
  "bun",
  "home",
  "linear",
  "linear-webhook",
  "public-url",
  "ngrok",
  "claude",
  "codex",
  "closeout",
  "repository",
  "github-app",
];

test("doctor reports every prerequisite when the probe is green", () => {
  const checks = doctorChecks(probe(true));
  expect(checks.map((item) => item.name)).toEqual(NAMES);
  expect(checks.every((item) => item.ok)).toBe(true);
  const text = formatDoctor(checks);
  expect(text.startsWith("paws doctor\n")).toBe(true);
  expect(text).toContain("ok claude:");
  expect(text).not.toContain("BEGIN OPENSSH");
});

test("doctor names what is missing and does not print secret values", () => {
  const checks = doctorChecks(
    probe(false, {
      LINEAR_WEBHOOK_SECRET: "whsec_do_not_print",
      GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/missing.pem",
    }),
  );
  expect(checks.every((item) => item.ok)).toBe(false);
  const text = formatDoctor(checks);
  expect(text).toContain("missing linear:");
  expect(text).toContain("missing github-app:");
  expect(text).not.toContain("whsec_do_not_print");
});

test("bun run paws doctor exits nonzero until prerequisites exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-doctor-"));
  const proc = Bun.spawn([process.execPath, "src/index.ts", "doctor"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(stdout).toContain("paws doctor");
  expect(stdout).toContain("missing linear:");
  expect(code).toBe(1);
});

function probe(ok: boolean, env: Record<string, string> = {}): DoctorProbe {
  const ready = ok
    ? {
        LINEAR_ACCESS_TOKEN: "configured",
        LINEAR_WEBHOOK_SECRET: "whsec",
        PAWS_PUBLIC_URL: "https://paws.ngrok-free.app",
        PAWS_GITHUB_REPOSITORY: "pmdroid/paws-demo",
        GITHUB_APP_ID: "1",
        GITHUB_APP_INSTALLATION_ID: "2",
        GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/paws-app.pem",
      }
    : env;
  return {
    env: { HOME: "/tmp/paws-home", ...ready },
    bunVersion: ok ? "1.4.2" : null,
    which(bin) {
      return ok ? `/usr/bin/${bin}` : null;
    },
    stat() {
      return ok ? { mode: 0o100600 } : null;
    },
    canWrite() {
      return ok;
    },
  };
}
