import { chmodSync, chownSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunnerJob, readRunnerResultFile, type RunnerJob } from "../../src/runner-execution";

const root = mkdtempSync(join(tmpdir(), "paws-short-native-reads-"));
chmodSync(root, 0o755);
const privileged = process.getuid!() === 0;
const runnerUid = privileged ? 1001 : process.getuid!();
const agentUid = privileged ? 1002 : runnerUid;
const agentGid = privileged ? 1002 : process.getgid!();
const resultsGid = privileged ? 1003 : agentGid;
const id = "01K00000000000000000000000";
const job: RunnerJob = {
  executionId: id,
  command: {
    id: "command",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1,
    expiresAt: 2,
    type: "probe",
    profile: { agent: "codex", model: null },
  },
};
function directory(path: string, uid: number, gid: number) {
  mkdirSync(path);
  chownSync(path, uid, gid);
  chmodSync(path, 0o750);
}
function file(path: string, contents: string, uid: number, gid: number) {
  writeFileSync(path, contents);
  chownSync(path, uid, gid);
  chmodSync(path, 0o640);
}
const spool = { root: join(root, "spool"), runnerUid, agentGid };
directory(spool.root, runnerUid, agentGid);
directory(join(spool.root, id), runnerUid, agentGid);
file(join(spool.root, id, "job.json"), JSON.stringify(job).padEnd(65_539), runnerUid, agentGid);
const results = { root: join(root, "results"), agentUid, resultsGid };
const payload = "actual-native-short-read".padEnd(65_539, "x");
if (privileged) {
  directory(results.root, 0, resultsGid);
  directory(join(results.root, id), agentUid, resultsGid);
  file(join(results.root, id, "result.json"), payload, agentUid, resultsGid);
  file(join(results.root, id, "events.jsonl"), payload, agentUid, resultsGid);
  process.setgroups!([resultsGid]);
  process.setgid!(agentGid);
  process.setuid!(runnerUid);
}
const metrics = (
  globalThis as unknown as {
    shortReadMetrics: { reset(): void; snapshot(): { allocatedBytes: number; reads: number } };
  }
).shortReadMetrics;
const observations: Record<string, unknown> = { privileged, root };
metrics.reset();
if (JSON.stringify(readRunnerJob(spool, id)) !== JSON.stringify(job))
  throw new Error("Short reads changed job content");
observations.job = metrics.snapshot();
if (privileged) {
  for (const name of ["result.json", "events.jsonl"] as const) {
    metrics.reset();
    if (readRunnerResultFile(results, id, name).toString() !== payload)
      throw new Error("Short reads changed result content");
    observations[name] = metrics.snapshot();
  }
}
console.log(JSON.stringify(observations));
