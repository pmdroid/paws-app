import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunnerInputFile } from "../../src/runner-protocol";
import type { RunnerWork } from "../../src/runner-work";
const root = fs.mkdtempSync(join(tmpdir(), "paws-input-fault-"));
let fault = "";
const original = { ...fs };
mock.module("node:fs", () => ({
  ...original,
  fstatSync(fd: number) {
    const path = original.readlinkSync(`/proc/self/fd/${fd}`);
    if (fault === "stat" && path.startsWith(root + "/"))
      throw Object.assign(new Error("Fault"), { code: "EIO" });
    return original.fstatSync(fd);
  },
  fsyncSync(fd: number) {
    if (fault === "sync" && original.readlinkSync(`/proc/self/fd/${fd}`) === root)
      throw Object.assign(new Error("Fault"), { code: "EIO" });
    return original.fsyncSync(fd);
  },
}));
const { createRunnerInputStore } = await import("../../src/runner-inputs");
let command = { type: "run" as const, id: "wide", inputFiles: [] as RunnerInputFile[] };
const store = createRunnerInputStore({
  root,
  work: { authorize: () => ({ command }) } as unknown as RunnerWork,
});
const access = { runnerId: "runner", runId: "run", token: "token" };
const observations = [];
command.inputFiles = store.stage(
  "wide",
  Array.from({ length: 20 }, (_, id) => ({
    path: `${id}/` + "界".repeat(4080),
    mimeType: "text/plain",
    bytes: Buffer.from("x"),
  })),
);
try {
  assert.equal(
    store.read(access, { commandId: "wide", generation: 1, fileId: 0, offset: 0 }).data,
    "eA==",
  );
  observations.push({ claim: "schema-valid Unicode manifest readable", passed: true });
} catch (error) {
  observations.push({
    claim: "schema-valid Unicode manifest readable",
    passed: false,
    error: String(error),
  });
}
command = {
  type: "run",
  id: "faults",
  inputFiles: store.stage("faults", [
    { path: "a", mimeType: "text/plain", bytes: Buffer.from("x") },
  ]),
};
for (const mode of ["stat", "sync"]) {
  const before = original.readdirSync("/proc/self/fd").length;
  fault = mode;
  for (let i = 0; i < 20; i++)
    assert.throws(() =>
      store.read(access, { commandId: "faults", generation: 1, fileId: 0, offset: 0 }),
    );
  fault = "";
  const leaked = original.readdirSync("/proc/self/fd").length - before;
  observations.push({
    claim: `${mode} failure closes command directory`,
    passed: leaked === 0,
    leaked,
  });
}
const folder = join(root, createHash("sha256").update("faults").digest("hex"));
const published = join(folder, "0.bytes");
original.linkSync(published, published + ".00000000-0000-4000-8000-000000000000");
try {
  store.stage("faults", [{ path: "a", mimeType: "text/plain", bytes: Buffer.from("x") }]);
  assert.equal(
    store.read(access, { commandId: "faults", generation: 1, fileId: 0, offset: 0 }).data,
    "eA==",
  );
  observations.push({ claim: "crashed hard-link publication exact retry", passed: true });
} catch (error) {
  observations.push({
    claim: "crashed hard-link publication exact retry",
    passed: false,
    error: String(error),
    canonicalStillExists: original.existsSync(published),
  });
}
console.log(JSON.stringify({ root, observations }, null, 2));
assert(observations.every((value) => value.passed));
