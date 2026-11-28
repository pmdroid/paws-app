import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkRunnerCompatibility, compatibilityFailures } from "../scripts/runner-compat";

const tree = resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const dir = mkdtempSync(join(tmpdir(), "paws-runner-compat-"));
  roots.push(dir);
  return dir;
}

test("a compatible runner and Paws renew heartbeats and deliver a command with its sign-in", async () => {
  const report = await checkRunnerCompatibility({
    pawsTree: tree,
    runnerTree: tree,
    root: temporaryRoot(),
  });
  expect(compatibilityFailures(report)).toEqual([]);
}, 60_000);

test("a runner that sends a heartbeat field Paws does not know fails", async () => {
  const report = await checkRunnerCompatibility({
    pawsTree: tree,
    runnerTree: tree,
    root: temporaryRoot(),
    unknownHostField: "newerHostField",
  });
  const failures = compatibilityFailures(report);
  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0]).toContain("rejected fields: newerHostField");
}, 60_000);

test("a runner reports its VM disks, and retries once without them when Paws refuses the field", async () => {
  const accepted = await checkRunnerCompatibility({
    pawsTree: tree,
    runnerTree: tree,
    root: temporaryRoot(),
  });
  expect(compatibilityFailures(accepted)).toEqual([]);
  expect(accepted.issueVmBodies).toEqual([["running", "sleepCheck", "disks"]]);
  const refused = await checkRunnerCompatibility({
    pawsTree: tree,
    runnerTree: tree,
    root: temporaryRoot(),
    refusedIssueVmField: "disks",
  });
  expect(compatibilityFailures(refused)).toEqual([]);
  expect(refused.issueVmBodies).toEqual([
    ["running", "sleepCheck", "disks"],
    ["running", "sleepCheck"],
  ]);
}, 120_000);
