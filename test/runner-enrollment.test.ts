import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDaemonEnrollment, probeRunnerEnrollment } from "./local/runner-enrollment";

async function run(
  prefix: string,
  probe: typeof probeRunnerEnrollment,
  expected: number,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const observations: string[] = [];
  try {
    await probe(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a member's enrollment token lets a host enroll itself once, owned by that member", async () => {
  await run("paws-runner-enrollment-", probeRunnerEnrollment, 5);
}, 30_000);

test("the daemon enrolls in one round trip and a retried enroll changes nothing", async () => {
  await run("paws-daemon-enrollment-", probeDaemonEnrollment, 2);
}, 30_000);
