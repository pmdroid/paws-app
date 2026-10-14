import { expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishRunnerJob,
  runnerTaskRepositoryPath,
  type RunnerJob,
} from "../src/runner-execution";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-snapshot-links-"));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(join(source, "nested"), { mode: 0o700 });
  writeFileSync(join(source, "nested", "schema.yaml"), "openapi: 3.1.0\n", { mode: 0o600 });
  const spoolRoot = join(root, "spool");
  mkdirSync(spoolRoot, { mode: 0o750 });
  chmodSync(spoolRoot, 0o750);
  const spool = { root: spoolRoot, runnerUid: process.getuid!(), agentGid: process.getgid!() };
  const job: RunnerJob = {
    executionId: "01K00000000000000000000000",
    command: {
      id: "command",
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
      profile: { agent: "claude", model: null },
      prompt: "Create an artifact",
      repository: {
        owner: "fixture",
        repo: "repository",
        remoteUrl: "https://github.com/fixture/repository.git",
        baseSha: "a".repeat(40),
      },
    },
  };
  return {
    root,
    source,
    spool,
    job,
    publish: () => publishRunnerJob(spool, job, { repositorySnapshot: source }),
  };
}

const supported = process.platform === "linux" && process.getuid!() > 0 && process.getgid!() > 0;

test.skipIf(!supported)(
  "internal file, directory and chained links become immutable snapshot copies",
  () => {
    const f = fixture();
    try {
      symlinkSync("nested/schema.yaml", join(f.source, "openapi.yaml"));
      symlinkSync("openapi.yaml", join(f.source, "chain.yaml"));
      symlinkSync("nested", join(f.source, "directory"));
      f.publish();
      f.publish();
      const stored = runnerTaskRepositoryPath(f.spool, f.job.executionId);
      for (const path of ["openapi.yaml", "chain.yaml", "directory/schema.yaml"]) {
        expect(readFileSync(join(stored, path), "utf8")).toBe("openapi: 3.1.0\n");
        expect(lstatSync(join(stored, path)).isSymbolicLink()).toBe(false);
      }
      writeFileSync(join(f.source, "nested", "schema.yaml"), "changed");
      expect(() => f.publish()).toThrow("different content");
      symlinkSync("nested/schema.yaml", join(stored, "forged.yaml"));
      expect(() => runnerTaskRepositoryPath(f.spool, f.job.executionId)).toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

for (const target of ["/etc/passwd", "../source-neighbor/private", "missing", "."]) {
  test.skipIf(!supported)(
    `snapshot link ${target} is rejected without publishing partial input`,
    () => {
      const f = fixture();
      try {
        mkdirSync(join(f.root, "source-neighbor"));
        writeFileSync(join(f.root, "source-neighbor", "private"), "private");
        symlinkSync(target, join(f.source, "link"));
        expect(() => f.publish()).toThrow();
        expect(() => runnerTaskRepositoryPath(f.spool, f.job.executionId)).toThrow();
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(!supported)("a link to an ancestor inside the snapshot cannot recurse", () => {
  const f = fixture();
  try {
    symlinkSync(".", join(f.source, "nested", "cycle"));
    expect(() => f.publish()).toThrow("directory cycle");
    expect(() => runnerTaskRepositoryPath(f.spool, f.job.executionId)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
