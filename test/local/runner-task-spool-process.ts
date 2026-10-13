import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  publishRunnerJob,
  readRunnerJob,
  runnerTaskRepositoryPath,
  type RunnerJob,
} from "../../src/runner-execution";

const mode = process.argv[2];
const root = "/proof/data";
const spool = { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 };
const source = join(root, "source");
const executionId = "01K00000000000000000000001";
const job: RunnerJob = {
  executionId,
  command: {
    id: "task",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1,
    expiresAt: 2,
    type: "task",
    runId: "run",
    itemId: "item",
    generation: 1,
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "artifact",
    profile: { agent: "codex", model: null },
    prompt: "Read the private snapshot",
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    },
  },
};
if (mode === "publish") {
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested", "source.txt"), "private source\n", { mode: 0o644 });
  assert.throws(() => publishRunnerJob(spool, job), /snapshot/);
  assert.throws(() => publishRunnerJob(spool, job, { repositoryBundle: source }), /bundle/);
  const invalid = (name: string, prepare: () => void, cleanup: () => void) => {
    prepare();
    assert.throws(() => publishRunnerJob(spool, job, { repositorySnapshot: source }), name);
    assert(!existsSync(join(spool.root, executionId)));
    assert.deepEqual(readdirSync(spool.root), []);
    cleanup();
  };
  invalid(
    "metadata",
    () => mkdirSync(join(source, ".git")),
    () => rmSync(join(source, ".git"), { recursive: true }),
  );
  invalid(
    "symlink",
    () => symlinkSync("/etc/passwd", join(source, "link")),
    () => rmSync(join(source, "link")),
  );
  invalid(
    "hardlink",
    () => linkSync(join(source, "nested", "source.txt"), join(source, "hard")),
    () => rmSync(join(source, "hard")),
  );
  invalid(
    "oversize",
    () => {
      writeFileSync(join(source, "large"), "");
      truncateSync(join(source, "large"), 536_870_912);
    },
    () => rmSync(join(source, "large")),
  );
  invalid(
    "writable directory",
    () => chmodSync(join(source, "nested"), 0o777),
    () => chmodSync(join(source, "nested"), 0o755),
  );
  symlinkSync(source, join(root, "alias"));
  assert.throws(() => publishRunnerJob(spool, job, { repositorySnapshot: join(root, "alias") }));
  assert.deepEqual(publishRunnerJob(spool, job, { repositorySnapshot: source }), job);
  assert.deepEqual(publishRunnerJob(spool, job, { repositorySnapshot: source }), job);
  writeFileSync(join(source, "nested", "source.txt"), "changed source\n");
  assert.throws(
    () => publishRunnerJob(spool, job, { repositorySnapshot: source }),
    /different content/,
  );
  const repository = runnerTaskRepositoryPath(spool, executionId);
  assert.equal(readFileSync(join(repository, "nested", "source.txt"), "utf8"), "private source\n");
  for (const path of [repository, join(repository, "nested")])
    assert.equal(statSync(path).mode & 0o7777, 0o750);
  const file = statSync(join(repository, "nested", "source.txt"));
  assert.equal(file.mode & 0o7777, 0o640);
  assert.equal(file.uid, 1001);
  assert.equal(file.gid, 1002);
  if (job.command.type !== "task") throw new Error("Task required");
  const { repository: ignored, ...without } = job.command;
  assert(ignored);
  const optional = {
    executionId: "01K00000000000000000000002",
    command: { ...without, id: "optional" },
  };
  assert.throws(() => publishRunnerJob(spool, optional, { repositorySnapshot: source }), /context/);
  publishRunnerJob(spool, optional);
  assert.throws(() => runnerTaskRepositoryPath(spool, optional.executionId), /no task repository/);
  console.log(
    JSON.stringify({
      published: true,
      invalidSourcesRejected: 6,
      atomicRefusals: true,
      byteIdenticalRetry: true,
      changedRetryDenied: true,
      repositoryOptional: true,
    }),
  );
} else if (mode === "atomic") {
  publishRunnerJob(
    spool,
    {
      ...job,
      executionId: "01K00000000000000000000003",
      command: { ...job.command, id: "atomic" },
    },
    { repositorySnapshot: join(root, "atomic-source") },
  );
  console.log(JSON.stringify({ published: true }));
} else if (mode === "staging") {
  assert.throws(() => readFileSync(process.argv[3]!));
  console.log(JSON.stringify({ inFlightReadDenied: true }));
} else if (mode === "agent") {
  assert.deepEqual(readRunnerJob(spool, executionId), job);
  const path = join(runnerTaskRepositoryPath(spool, executionId), "nested", "source.txt");
  assert.equal(readFileSync(path, "utf8"), "private source\n");
  assert.throws(() => writeFileSync(path, "forged"));
  assert.throws(() => chmodSync(path, 0o660));
  assert.throws(() => publishRunnerJob(spool, job, { repositorySnapshot: source }));
  console.log(
    JSON.stringify({ readable: true, writeDenied: true, chmodDenied: true, publishDenied: true }),
  );
} else if (mode === "outsider") {
  assert.throws(() => readRunnerJob(spool, executionId));
  console.log(JSON.stringify({ inputReadDenied: true }));
} else if (mode === "tampered") {
  assert.throws(() => readRunnerJob(spool, executionId));
  console.log(JSON.stringify({ unsafePublishedTreeDenied: true }));
} else throw new Error("Unknown task spool proof mode");
