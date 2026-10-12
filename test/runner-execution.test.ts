import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createServer } from "node:net";
import {
  createRunnerBrokerClient,
  publishRunnerJob,
  readRunnerJob,
  runnerRepositoryBundlePath,
  type RunnerJob,
} from "../src/runner-execution";

const root = mkdtempSync(join(tmpdir(), "paws-execution-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const id = "01K00000000000000000000000";
const probe: RunnerJob = {
  executionId: id,
  command: {
    id: "cmd",
    runnerId: "runner",
    workspaceId: "ws",
    issuedAt: 1,
    expiresAt: 2,
    type: "probe",
    profile: { agent: "codex", model: null },
  },
};

function spool(name: string) {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o750 });
  chmodSync(path, 0o750);
  return { root: path, runnerUid: process.getuid!(), agentGid: process.getgid!() };
}

describe("Linux execution spool", () => {
  test.skipIf(process.platform !== "linux")(
    "publishes immutable sanitized jobs and retries the same publication",
    () => {
      const files = spool("happy");
      expect(publishRunnerJob(files, probe)).toEqual(probe);
      expect(readRunnerJob(files, id)).toEqual(probe);
      expect(publishRunnerJob(files, probe)).toEqual(probe);
      expect(() =>
        publishRunnerJob(files, { ...probe, command: { ...probe.command, id: "changed" } }),
      ).toThrow("already exists");
      expect(() =>
        publishRunnerJob(files, { ...probe, grant: "synthetic" } as RunnerJob),
      ).toThrow();
      expect(() =>
        publishRunnerJob(files, {
          ...probe,
          command: { ...probe.command, token: "synthetic" },
        } as unknown as RunnerJob),
      ).toThrow();
      expect(() => publishRunnerJob(files, { ...probe, executionId: "../../private" })).toThrow();
      expect(() => runnerRepositoryBundlePath(files, id)).toThrow("no repository");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "rejects unsafe roots, directories, symlinks and hardlinked input",
    () => {
      const files = spool("unsafe");
      publishRunnerJob(files, probe);
      const job = join(files.root, id, "job.json");
      chmodSync(job, 0o660);
      expect(() => readRunnerJob(files, id)).toThrow("Unsafe");
      chmodSync(job, 0o2640);
      expect(() => readRunnerJob(files, id)).toThrow("Unsafe");
      chmodSync(job, 0o640);
      chmodSync(join(files.root, id), 0o2750);
      expect(() => readRunnerJob(files, id)).toThrow("Unsafe");
      chmodSync(join(files.root, id), 0o750);
      chmodSync(files.root, 0o2750);
      expect(readRunnerJob(files, id)).toEqual(probe);
      linkSync(job, join(root, "hardlink"));
      expect(() => readRunnerJob(files, id)).toThrow("Unsafe");
      rmSync(join(root, "hardlink"));
      rmSync(job);
      writeFileSync(join(root, "replacement"), JSON.stringify(probe), { mode: 0o640 });
      symlinkSync(join(root, "replacement"), job);
      expect(() => readRunnerJob(files, id)).toThrow();
      rmSync(join(files.root, id), { recursive: true });
      symlinkSync(root, join(files.root, id));
      expect(() => readRunnerJob(files, id)).toThrow();
      chmodSync(files.root, 0o770);
      expect(() => readRunnerJob(files, id)).toThrow("Unsafe");
      const alias = join(root, "alias");
      symlinkSync(files.root, alias);
      expect(() => readRunnerJob({ ...files, root: alias }, id)).toThrow();
    },
  );

  test.skipIf(process.platform !== "linux")(
    "repository work requires a private bundle and publishes a read-only copy",
    () => {
      const files = spool("repository");
      const source = join(root, "source.bundle");
      writeFileSync(source, "synthetic git bundle", { mode: 0o600 });
      const work: RunnerJob = {
        executionId: id,
        command: {
          ...probe.command,
          type: "run",
          runId: "run",
          itemId: "item",
          generation: 1,
          repository: {
            owner: "owner",
            repo: "repo",
            remoteUrl: "https://github.com/owner/repo.git",
            baseSha: "a".repeat(40),
          },
          profile: { agent: "codex", model: null },
          prompt: "Run synthetic task",
        },
      };
      expect(() => publishRunnerJob(files, work)).toThrow("bundle");
      expect(() => publishRunnerJob(files, probe, { repositoryBundle: source })).toThrow("bundle");
      chmodSync(source, 0o666);
      expect(() => publishRunnerJob(files, work, { repositoryBundle: source })).toThrow("Unsafe");
      chmodSync(source, 0o600);
      const linkedParent = join(root, "linked-bundle-parent");
      symlinkSync(root, linkedParent);
      expect(() =>
        publishRunnerJob(files, work, {
          repositoryBundle: join(linkedParent, "source.bundle"),
        }),
      ).toThrow();
      expect(() =>
        publishRunnerJob(files, work, { repositoryBundle: `${root}/./source.bundle` }),
      ).toThrow();
      expect(() =>
        publishRunnerJob(files, work, { repositoryBundle: relative(process.cwd(), source) }),
      ).toThrow();
      const previousUmask = process.umask(0);
      try {
        publishRunnerJob(files, work, { repositoryBundle: source });
      } finally {
        process.umask(previousUmask);
      }
      const bundle = runnerRepositoryBundlePath(files, id);
      expect(readFileSync(bundle, "utf8")).toBe("synthetic git bundle");
      expect(statSync(bundle).mode & 0o7777).toBe(0o640);
      expect(publishRunnerJob(files, work, { repositoryBundle: source })).toEqual(work);
      writeFileSync(source, "source changed");
      expect(() => publishRunnerJob(files, work, { repositoryBundle: source })).toThrow(
        "different content",
      );
      expect(readFileSync(bundle, "utf8")).toBe("synthetic git bundle");
      chmodSync(bundle, 0o660);
      expect(() => readRunnerJob(files, id)).toThrow("Unsafe");
      chmodSync(bundle, 0o640);
      rmSync(bundle);
      expect(() => publishRunnerJob(files, work, { repositoryBundle: source })).toThrow();
      expect(JSON.parse(readFileSync(join(files.root, id, "job.json"), "utf8"))).toEqual(work);
      rmSync(join(files.root, id, "job.json"));
      expect(() => publishRunnerJob(files, work, { repositoryBundle: source })).toThrow();
    },
  );

  test("fixed broker client validates IDs and waits for its stop response", async () => {
    const socketPath = join(root, "broker.sock");
    const requests: unknown[] = [];
    let stopped = false;
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString());
        requests.push(request);
        if (request.operation === "start") socket.write('{"ok":true,"alreadyAdmitted":false}\n');
        else
          setTimeout(() => {
            stopped = true;
            socket.end('{"ok":true}\n');
          }, 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = createRunnerBrokerClient({ socketPath });
      expect(await client.start(id)).toEqual({ alreadyAdmitted: false });
      await client.stop(id);
      expect(stopped).toBe(true);
      expect(requests).toEqual([
        { operation: "start", executionId: id },
        { operation: "stop", executionId: id },
      ]);
      expect(() => client.start("../../other.service")).toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
