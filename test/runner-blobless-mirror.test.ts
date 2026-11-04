import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { runGitHubGit } from "../src/github";
import type { RunnerJob } from "../src/runner-execution";
import { createRunnerRepositories } from "../src/runner-repositories";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

type Call = { operation: string; token: string; filter?: string; objects?: string[] };

async function fixture(options: { fullMirror?: boolean; skipPrefetch?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-blobless-mirror-"));
  roots.push(root);
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  mkdirSync(home);
  await git(["init", "-q", "-b", "main", source], { env });
  const blob = (content: Buffer | string) => {
    const bytes = Buffer.from(content);
    return Buffer.concat([Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from("\n")]);
  };
  const parts: Buffer[] = [];
  for (let index = 1; index <= 250; index++) {
    parts.push(
      Buffer.from(
        `commit refs/heads/main\ncommitter Fixture <fixture@example.com> ${1_700_000_000 + index} +0000\n`,
      ),
      blob(`commit ${index}`),
    );
    if (index === 1)
      parts.push(Buffer.from("M 100644 inline big.bin\n"), blob(randomBytes(2_000_000)));
    else if (index === 2) parts.push(Buffer.from("M 100644 inline big.bin\n"), blob("small\n"));
    else parts.push(Buffer.from("M 100644 inline count.txt\n"), blob(`${index}\n`));
    parts.push(Buffer.from("\n"));
  }
  writeFileSync(join(root, "history.fi"), Buffer.concat(parts));
  const imported = Bun.spawn(["git", "-C", source, "fast-import", "--quiet"], {
    stdin: Bun.file(join(root, "history.fi")),
    env,
  });
  expect(await imported.exited).toBe(0);
  await git(["clone", "-q", "--bare", source, origin], { env });
  await git(["--git-dir", origin, "config", "uploadpack.allowFilter", "true"], { env });
  await git(["--git-dir", origin, "config", "uploadpack.allowAnySHA1InWant", "true"], { env });
  const rev = async (name: string) => (await git(["--git-dir", origin, "rev-parse", name])).trim();
  const mainSha = await rev("main");
  const baseSha = await rev("main~1");
  const oldBlob = await rev("main~249:big.bin");
  const lazyLog = join(root, "lazy.log");
  const refuse = join(root, "refuse-upload-pack");
  writeFileSync(refuse, `#!/bin/sh\necho lazy >> '${lazyLog}'\nexit 1\n`, { mode: 0o700 });
  const command: Extract<RunnerJob["command"], { type: "run" }> = {
    id: "cmd",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "01J0000000000000000000RUN1",
    itemId: "item",
    generation: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    repository: {
      owner: "acme",
      repo: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
      baseSha,
      mainSha,
    },
    prompt: "Implement",
    checkpointBot: { appId: "99", login: "paws-test[bot]", id: 88 },
  };
  const calls: Call[] = [];
  const repositories = createRunnerRepositories({
    root: join(root, "cache"),
    home,
    credential: async (_, access) => `synthetic-${access}`,
    async networkGit(input) {
      calls.push({
        operation: input.operation,
        token: input.token,
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.objects ? { objects: input.objects } : {}),
      });
      if (input.objects && options.skipPrefetch) return;
      if (input.operation !== "clone") {
        await runGitHubGit({ ...input, remoteUrl: origin });
        return;
      }
      const filter = input.filter && !options.fullMirror ? [`--filter=${input.filter}`] : [];
      await git(["clone", "-q", "--bare", ...filter, `file://${origin}`, input.dest!], { env });
      await git(["--git-dir", input.dest!, "config", "remote.origin.uploadpack", refuse], { env });
    },
  });
  const mirror = join(
    root,
    "cache",
    `${createHash("sha256").update("acme/repo").digest("hex")}.git`,
  );
  const inMirror = (args: string[]) =>
    Bun.spawnSync(["git", "--git-dir", mirror, ...args], {
      env: { ...env, GIT_NO_LAZY_FETCH: "1" },
    });
  const blobs = async (...tips: string[][]) => {
    const objects = new Set<string>();
    for (const tip of tips)
      for (const line of (await git(["--git-dir", origin, "rev-list", "--objects", ...tip])).split(
        "\n",
      ))
        if (line) objects.add(line.split(" ")[0]!);
    const typed = Bun.spawnSync(
      ["git", "--git-dir", origin, "cat-file", "--batch-check=%(objecttype) %(objectname)"],
      { stdin: Buffer.from(`${[...objects].join("\n")}\n`), env },
    );
    return typed.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("blob "))
      .map((line) => line.slice(5))
      .sort();
  };
  const snapshotBlobs = () => blobs(["--max-count=200", baseSha], ["--max-count=200", mainSha]);
  const allBlobs = () => blobs(["--all"]);
  const missing = () =>
    inMirror(["rev-list", "--objects", "--no-object-names", "--missing=print", "--all"])
      .stdout.toString()
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
  const objectBytes = () =>
    Number(
      /size-pack: (\d+)/.exec(inMirror(["count-objects", "-v"]).stdout.toString())?.[1] ?? NaN,
    ) +
    Number(/^size: (\d+)/m.exec(inMirror(["count-objects", "-v"]).stdout.toString())?.[1] ?? NaN);
  const lazyFetches = () => (existsSync(lazyLog) ? readFileSync(lazyLog, "utf8") : "");
  return {
    root,
    origin,
    baseSha,
    mainSha,
    oldBlob,
    command,
    calls,
    repositories,
    mirror,
    inMirror,
    snapshotBlobs,
    allBlobs,
    missing,
    objectBytes,
    lazyFetches,
  };
}

test.skipIf(!linux)(
  "a fresh mirror is a blobless partial clone that prefetches exactly the snapshot's blobs with the credential",
  async () => {
    const f = await fixture();
    const prepared = await f.repositories.prepare(f.command);
    expect(f.calls[0]).toEqual({
      operation: "clone",
      token: "synthetic-read",
      filter: "blob:none",
    });
    expect(f.inMirror(["config", "remote.origin.promisor"]).stdout.toString().trim()).toBe("true");
    expect(f.inMirror(["cat-file", "-e", f.oldBlob]).exitCode).not.toBe(0);
    const snapshot = await f.snapshotBlobs();
    expect(f.missing().sort()).toEqual(
      (await f.allBlobs()).filter((blob) => !snapshot.includes(blob)),
    );
    expect(f.missing()).toContain(f.oldBlob);
    expect(f.objectBytes()).toBeLessThan(500);
    const fetched = f.calls.filter((call) => call.objects);
    expect(fetched.length).toBeGreaterThan(0);
    for (const call of fetched) {
      expect(call).toMatchObject({ operation: "fetch", token: "synthetic-read" });
      expect(call.objects!.length).toBeLessThanOrEqual(1_000);
    }
    expect(fetched.flatMap((call) => call.objects!).sort()).toEqual(await f.snapshotBlobs());
    expect(prepared.blobs).toBeDefined();
    expect(f.lazyFetches()).toBe("");
    rmSync(prepared.bundle, { force: true });
    if (prepared.blobs) rmSync(prepared.blobs, { force: true });

    f.calls.length = 0;
    const again = await f.repositories.prepare({ ...f.command, id: "cmd-2" });
    expect(f.calls).toEqual([{ operation: "fetch", token: "synthetic-read" }]);
    expect(again.blobs).toBeDefined();
    expect(f.lazyFetches()).toBe("");
  },
  60_000,
);

test.skipIf(!linux)(
  "a snapshot whose blobs were not prefetched fails instead of fetching without the credential",
  async () => {
    const f = await fixture({ skipPrefetch: true });
    await expect(f.repositories.prepare(f.command)).rejects.toThrow();
    expect(f.calls.some((call) => call.objects)).toBe(true);
    expect(f.lazyFetches()).toBe("");
    const [blob] = await f.snapshotBlobs();
    Bun.spawnSync(["git", "--git-dir", f.mirror, "cat-file", "-p", blob!], { env });
    expect(f.lazyFetches()).toBe("lazy\n");
  },
  60_000,
);

test.skipIf(!linux)(
  "an existing full mirror keeps working unchanged and fetches no objects",
  async () => {
    const f = await fixture({ fullMirror: true });
    const first = await f.repositories.prepare(f.command);
    expect(f.inMirror(["config", "remote.origin.promisor"]).exitCode).not.toBe(0);
    expect(f.missing()).toEqual([]);
    expect(f.inMirror(["cat-file", "-s", f.oldBlob]).stdout.toString().trim()).toBe("2000000");
    expect(first.blobs).toBeDefined();
    expect(f.calls.filter((call) => call.objects)).toEqual([]);
    f.calls.length = 0;
    const again = await f.repositories.prepare({ ...f.command, id: "cmd-2" });
    expect(f.calls).toEqual([{ operation: "fetch", token: "synthetic-read" }]);
    expect(again.blobs).toBeDefined();
  },
  60_000,
);

test.skipIf(!linux)(
  "publishing a candidate into a blobless mirror only adds its new objects",
  async () => {
    const f = await fixture();
    await f.repositories.prepare(f.command);
    const before = f.missing();
    const work = join(f.root, "work");
    await git(["clone", "-q", "--branch", "main", f.origin, work], { env });
    await git(["-C", work, "reset", "-q", "--hard", f.baseSha], { env });
    writeFileSync(join(work, "change.txt"), "agent change\n");
    await git(["-C", work, "add", "change.txt"], { env });
    await git(["-C", work, "commit", "-q", "-m", "Change"], { env });
    const sha = (await git(["-C", work, "rev-parse", "HEAD"])).trim();
    const path = join(f.root, "candidate.bundle");
    await git(["-C", work, "bundle", "create", "-q", path, "HEAD", `^${f.baseSha}`], { env });
    const bundle = Buffer.from(readFileSync(path));
    expect(await f.repositories.publish(f.command, { bundle, sha, branch: "paws/candidate" })).toBe(
      sha,
    );
    expect(f.calls.at(-1)).toMatchObject({ operation: "push", token: "synthetic-write" });
    expect(
      (await git(["--git-dir", f.origin, "rev-parse", "refs/heads/paws/candidate"])).trim(),
    ).toBe(sha);
    expect(f.missing()).toEqual(before);
    expect(f.inMirror(["cat-file", "-e", `${sha}:change.txt`]).exitCode).toBe(0);
    expect(f.lazyFetches()).toBe("");
  },
  60_000,
);
