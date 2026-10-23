import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  watch,
  existsSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { git } from "../../src/acp";
import { runGitHubGit } from "../../src/github";
import { createRunnerRepositories } from "../../src/runner-repositories";
import type { RunnerCommand } from "../../src/runner-protocol";

export async function probeRunnerRepositories(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  privateInputs = false,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const invoke = (args: string[]) => git(args, { env });
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  await invoke(["init", "-b", "main", source]);
  writeFileSync(join(source, "base.txt"), "base\n");
  await invoke(["-C", source, "add", "."]);
  await invoke(["-C", source, "commit", "-m", "base"]);
  const baseSha = (await invoke(["-C", source, "rev-parse", "HEAD"])).trim();
  await invoke(["clone", "--bare", source, origin]);
  const now = Date.now();
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: randomUUID(),
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + 60_000,
    type: "run",
    runId: randomUUID(),
    itemId: randomUUID(),
    generation: 1,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha,
    },
    profile: { agent: "claude", model: null },
    prompt: "Implement the task.",
  };
  const gitBin = join(root, "recording-git");
  const compiler = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      fileURLToPath(new URL("../fixtures/runner-git-recorder.ts", import.meta.url)),
      "--outfile",
      gitBin,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const [compiled, compilationError] = await Promise.all([
    compiler.exited,
    new Response(compiler.stderr).text(),
  ]);
  assert.equal(compiled, 0, compilationError);
  const calls: { operation: string; token: string; args: string[]; signal?: AbortSignal }[] = [];
  const credentials: string[] = [];
  const options = {
    root: join(root, "cache"),
    home,
    async credential(job: RunnerCommand, access: "read" | "write") {
      assert.equal("runId" in job ? job.runId : null, command.runId);
      credentials.push(access);
      return `fixture-${access}`;
    },
    async networkGit(input: {
      operation: "clone" | "fetch" | "push";
      remoteUrl: string;
      token: string;
      cwd: string;
      dest?: string;
      refspec?: string;
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
    }) {
      assert.equal(input.remoteUrl, command.repository.remoteUrl);
      assert.equal(input.env.HOME, home);
      assert(!Object.values(input.env).includes(input.token));
      const args =
        input.operation === "clone"
          ? ["clone", "--bare", origin, input.dest!]
          : input.operation === "fetch"
            ? ["--git-dir", input.dest!, "fetch", origin, "+refs/heads/*:refs/heads/*"]
            : ["--git-dir", input.cwd, "push", origin, input.refspec!];
      assert(!args.some((value) => value.includes(input.token)));
      calls.push({ operation: input.operation, token: input.token, args, signal: input.signal });
      await runGitHubGit({ ...input, remoteUrl: origin, gitBin });
    },
  };
  const retryRoot = join(root, "clone-retry");
  let firstClone = true;
  const retryOptions = {
    ...options,
    root: retryRoot,
    async networkGit(input: Parameters<NonNullable<typeof options.networkGit>>[0]) {
      assert.equal(input.operation, "clone");
      if (firstClone) {
        firstClone = false;
        mkdirSync(input.dest!, { mode: 0o700 });
        writeFileSync(join(input.dest!, "partial"), "interrupted clone");
        throw new DOMException("Interrupted clone", "AbortError");
      }
      await options.networkGit(input);
    },
  };
  const retryMirror = join(
    retryRoot,
    `${createHash("sha256").update("fixture/repository").digest("hex")}.git`,
  );
  await assert.rejects(
    createRunnerRepositories(retryOptions).prepare(command),
    /Interrupted clone/,
  );
  assert.equal(existsSync(retryMirror), false);
  const recoveredClone = await createRunnerRepositories(retryOptions).prepare(command);
  assert.equal(
    (
      await invoke(["--git-dir", recoveredClone.mirror, "rev-parse", "--is-bare-repository"])
    ).trim(),
    "true",
  );
  rmSync(retryMirror, { recursive: true });
  mkdirSync(retryMirror, { mode: 0o700 });
  writeFileSync(join(retryMirror, "legacy-partial"), "interrupted clone");
  const recoveredLegacy = await createRunnerRepositories(retryOptions).prepare(command);
  assert.equal(
    (
      await invoke(["--git-dir", recoveredLegacy.mirror, "rev-parse", "--is-bare-repository"])
    ).trim(),
    "true",
  );
  calls.length = 0;
  observe(
    "interrupted and legacy partial clones recover with a fresh adapter and real Git clone",
    true,
    { failedCloneUnpublished: true, legacyPartialRecloned: true },
  );
  const repositories = createRunnerRepositories(options);
  const parallelCalls: string[] = [];
  const parallelOptions = {
    ...options,
    root: join(root, "parallel-cache"),
    async networkGit(input: Parameters<typeof options.networkGit>[0]) {
      parallelCalls.push(input.operation);
      await options.networkGit(input);
    },
  };
  const parallelSnapshots = await Promise.all(
    [1, 2].map(() =>
      createRunnerRepositories(parallelOptions).prepare({ ...command, id: randomUUID() }),
    ),
  );
  assert.deepEqual(parallelCalls, ["clone", "fetch"]);
  assert.equal(parallelSnapshots[0]!.mirror, parallelSnapshots[1]!.mirror);
  assert.notEqual(parallelSnapshots[0]!.bundle, parallelSnapshots[1]!.bundle);
  for (const snapshot of parallelSnapshots)
    assert((await invoke(["bundle", "list-heads", snapshot.bundle])).startsWith(baseSha));
  observe("independent work commands serialize the same real Git cache", true, {
    operations: parallelCalls,
    independentBundles: 2,
  });
  calls.length = 0;
  const prepared = await repositories.prepare(command);
  assert.equal(statSync(prepared.bundle).mode & 0o777, 0o600);
  assert.equal(calls[0]?.token, "fixture-read");
  const tree = join(root, "worker-checkout");
  await invoke(["clone", "--no-checkout", prepared.bundle, tree]);
  await invoke(["-C", tree, "checkout", "-b", "candidate", baseSha]);
  assert.equal(readFileSync(join(tree, "base.txt"), "utf8"), "base\n");
  observe(
    "daemon fetches an assigned repository and prepares a private exact-base Git bundle",
    true,
    { baseSha, bundleMode: "0600", operation: calls[0]?.operation },
  );
  const review: Extract<RunnerCommand, { type: "review" }> = {
    id: randomUUID(),
    type: "review",
    runnerId: command.runnerId,
    workspaceId: command.workspaceId,
    issuedAt: now,
    expiresAt: now + 60_000,
    runId: command.runId,
    itemId: command.itemId,
    generation: 1,
    repository: command.repository,
    profile: command.profile,
    prompt: command.prompt,
  };
  const reviewSnapshot = await repositories.prepare(review);
  assert((await invoke(["bundle", "list-heads", reviewSnapshot.bundle])).startsWith(baseSha));
  assert.equal(calls.at(-1)?.token, "fixture-read");
  writeFileSync(join(tree, "candidate.txt"), "change\n");
  await invoke(["-C", tree, "add", "."]);
  await invoke(["-C", tree, "commit", "-m", "candidate"]);
  const sha = (await invoke(["-C", tree, "rev-parse", "HEAD"])).trim();
  const bundle = join(root, "candidate.bundle");
  await invoke(["-C", tree, "bundle", "create", bundle, "HEAD", `^${baseSha}`]);
  const candidate = { bundle: readFileSync(bundle), sha, branch: "paws/fixture-task" };
  await repositories.publish(command, candidate);
  assert.equal(
    (await invoke(["--git-dir", origin, "rev-parse", `refs/heads/${candidate.branch}`])).trim(),
    sha,
  );
  assert.equal(calls.at(-1)?.token, "fixture-write");
  observe(
    "daemon validates candidate ancestry and pushes the exact candidate with a separate write credential",
    true,
    { sha, branch: candidate.branch },
  );
  await createRunnerRepositories(options).publish(command, candidate);
  assert.equal(
    (await invoke(["--git-dir", origin, "rev-parse", `refs/heads/${candidate.branch}`])).trim(),
    sha,
  );
  observe(
    "a rebuilt repository adapter retries the same candidate against its unchanged durable cache",
    true,
    {
      replayedSha: sha,
    },
  );
  if (privateInputs) {
    const privatePath = "private-input.txt";
    const privateCommand = {
      ...command,
      inputFiles: [
        {
          id: 0,
          path: privatePath,
          mimeType: "text/plain",
          sizeBytes: 6,
          sha256: createHash("sha256").update("secret").digest("hex"),
        },
      ],
    };
    await repositories.publish(privateCommand, candidate);
    for (const variant of ["present", "removed", "renamed"]) {
      await invoke(["-C", tree, "checkout", "-B", "private-case", baseSha]);
      writeFileSync(join(tree, privatePath), "secret");
      await invoke(["-C", tree, "add", "."]);
      await invoke(["-C", tree, "commit", "-m", "private input"]);
      if (variant !== "present") {
        if (variant === "removed") await invoke(["-C", tree, "rm", privatePath]);
        else await invoke(["-C", tree, "mv", privatePath, "renamed.txt"]);
        await invoke(["-C", tree, "commit", "-m", "changed private input path"]);
      }
      const privateSha = (await invoke(["-C", tree, "rev-parse", "HEAD"])).trim();
      const privateBundle = join(root, `${variant}.bundle`);
      await invoke(["-C", tree, "bundle", "create", privateBundle, "HEAD", `^${baseSha}`]);
      const priorCredentials = credentials.length;
      const priorCalls = calls.length;
      await assert.rejects(
        repositories.publish(privateCommand, {
          bundle: readFileSync(privateBundle),
          sha: privateSha,
          branch: `paws/private-${variant}`,
        }),
        /Private runner input/,
      );
      assert.equal(credentials.length, priorCredentials);
      assert.equal(calls.length, priorCalls);
      await assert.rejects(
        invoke(["--git-dir", origin, "rev-parse", `refs/heads/paws/private-${variant}`]),
      );
    }
    observe(
      "private input paths in any candidate commit fail before write credentials or push",
      true,
      {
        presentDenied: true,
        removedEarlierCommitDenied: true,
        renamedDenied: true,
        ordinaryCandidateAllowed: true,
        writeCredentialsUnchanged: true,
      },
    );
  }
  const pushes = calls.filter((call) => call.operation === "push").length;
  await assert.rejects(
    repositories.publish(command, { ...candidate, sha: "f".repeat(40) }),
    /does not match/,
  );
  await assert.rejects(repositories.publish(command, { ...candidate, branch: "main" }), /Invalid/);
  await assert.rejects(
    repositories.publish({ ...command, type: "review" }, candidate),
    /Only a run/,
  );
  assert.equal(calls.filter((call) => call.operation === "push").length, pushes);
  observe("mismatched candidates, protected branches, and reviewers fail before push", true, {
    rejected: 3,
    pushes,
  });
  const headerEnd = candidate.bundle.indexOf("\n\n");
  assert(headerEnd > 0);
  const extraRefs = Array.from(
    { length: 12_000 },
    (_, index) => `${sha} refs/heads/fixture-${index}-${"x".repeat(900)}\n`,
  ).join("");
  const verboseBundle = Buffer.concat([
    candidate.bundle.subarray(0, headerEnd + 1),
    Buffer.from(extraRefs),
    candidate.bundle.subarray(headerEnd + 1),
  ]);
  const beforeVerbose = calls.length;
  await assert.rejects(
    repositories.publish(
      command,
      { ...candidate, bundle: verboseBundle },
      AbortSignal.timeout(60_000),
    ),
    /Git output exceeds limit/,
  );
  assert.equal(calls.length, beforeVerbose);
  observe("oversized candidate Git output is bounded before requesting a write credential", true, {
    bundleBytes: verboseBundle.length,
    refCount: 12_000,
    networkCallsUnchanged: true,
  });
  writeFileSync(join(source, "new.txt"), "updated remote\n");
  await invoke(["-C", source, "add", "."]);
  await invoke(["-C", source, "commit", "-m", "remote update"]);
  const updatedSha = (await invoke(["-C", source, "rev-parse", "HEAD"])).trim();
  await invoke(["-C", source, "push", origin, "main"]);
  const updated = await repositories.prepare({
    ...command,
    repository: { ...command.repository, baseSha: updatedSha },
  });
  assert.equal(updated.mirror, prepared.mirror);
  assert(calls.some((call) => call.operation === "fetch"));
  await invoke(["--git-dir", updated.mirror, "cat-file", "-e", `${updatedSha}^{commit}`]);
  observe("subsequent assignments fetch repository updates into the existing daemon mirror", true, {
    updatedSha,
    sameMirror: true,
  });
  const rebase = {
    ...command,
    id: randomUUID(),
    repository: { ...command.repository, baseSha: sha, mainSha: updatedSha },
  };
  const rebaseSnapshot = await repositories.prepare(rebase);
  const rebaseTree = join(root, "rebase-checkout");
  await invoke(["clone", "--no-checkout", rebaseSnapshot.bundle, rebaseTree]);
  await invoke(["-C", rebaseTree, "checkout", "-b", "candidate", sha]);
  await invoke(["-C", rebaseTree, "rebase", updatedSha]);
  const rebasedSha = (await invoke(["-C", rebaseTree, "rev-parse", "HEAD"])).trim();
  const rebasedBundle = join(root, "rebased.bundle");
  await invoke([
    "-C",
    rebaseTree,
    "bundle",
    "create",
    rebasedBundle,
    "HEAD",
    `^${sha}`,
    `^${updatedSha}`,
  ]);
  const rebasedCandidate = {
    bundle: readFileSync(rebasedBundle),
    sha: rebasedSha,
    branch: candidate.branch,
  };
  await repositories.publish(rebase, rebasedCandidate);
  await repositories.publish(rebase, rebasedCandidate);
  const rebasedRemote = (
    await invoke(["--git-dir", origin, "rev-parse", `refs/heads/${candidate.branch}`])
  ).trim();
  await invoke(["-C", rebaseTree, "commit", "--amend", "-m", "candidate again"]);
  const staleSha = (await invoke(["-C", rebaseTree, "rev-parse", "HEAD"])).trim();
  const staleBundle = join(root, "stale.bundle");
  await invoke(["-C", rebaseTree, "bundle", "create", staleBundle, "HEAD", `^${updatedSha}`]);
  await assert.rejects(
    repositories.publish(rebase, {
      bundle: readFileSync(staleBundle),
      sha: staleSha,
      branch: candidate.branch,
    }),
  );
  observe(
    "a candidate rebased onto the assigned main replaces only the branch head it was based on",
    rebasedRemote === rebasedSha,
    { baseSha: sha, mainSha: updatedSha, rebasedSha },
  );
  await assert.rejects(
    repositories.prepare({
      ...command,
      repository: { ...command.repository, baseSha: "f".repeat(40) },
    }),
  );
  const lock = join(prepared.mirror, "packed-refs.lock");
  async function holdPackedRefs() {
    await invoke(["--git-dir", prepared.mirror, "config", "core.packedRefsTimeout", "-1"]);
    writeFileSync(lock, "fixture lock", { flag: "wx", mode: 0o600 });
  }
  async function releasePackedRefs() {
    rmSync(lock, { force: true });
    await invoke(["--git-dir", prepared.mirror, "config", "--unset", "core.packedRefsTimeout"]);
  }
  async function abortOnceExists(
    path: string,
    preparing: Promise<unknown>,
    abort: AbortController,
  ) {
    const settled = preparing.then(
      () => true,
      () => true,
    );
    while (!existsSync(path)) {
      if (await Promise.race([settled, Bun.sleep(1).then(() => false)])) break;
    }
    const seen = existsSync(path);
    abort.abort();
    rmSync(lock, { force: true });
    return seen;
  }

  const interrupted = { ...command, id: randomUUID() };
  const interruptedHash = createHash("sha256").update(interrupted.id).digest("hex");
  const interruptedSnapshot = join(options.root, `snapshot-${interruptedHash}.bundle`);
  const abort = new AbortController();
  await holdPackedRefs();
  try {
    const preparing = repositories.prepare(interrupted, abort.signal);
    assert(await abortOnceExists(interruptedSnapshot, preparing, abort));
    await assert.rejects(preparing, { name: "AbortError" });
    assert.equal(calls.at(-1)?.signal, abort.signal);
    assert.equal(existsSync(interruptedSnapshot), false);
  } finally {
    await releasePackedRefs();
  }

  const blocked = { ...command, id: randomUUID() };
  const blockedHash = createHash("sha256").update(blocked.id).digest("hex");
  const blockedRef = `paws-snapshot-${blockedHash}`;
  const blockedSnapshot = join(options.root, `snapshot-${blockedHash}.bundle`);
  const snapshotWritten = Promise.withResolvers<void>();
  const snapshotWatcher = watch(options.root, (_event, filename) => {
    if (filename === `snapshot-${blockedHash}.bundle`) snapshotWritten.resolve();
  });
  writeFileSync(lock, "fixture lock", { flag: "wx", mode: 0o600 });
  try {
    await assert.rejects(repositories.prepare(blocked));
    await snapshotWritten.promise;
    assert(existsSync(lock));
    assert.equal(existsSync(blockedSnapshot), false);
  } finally {
    snapshotWatcher.close();
    rmSync(lock, { force: true });
    await invoke(["--git-dir", prepared.mirror, "update-ref", "-d", `refs/heads/${blockedRef}`]);
  }
  const refAbortCommand = { ...command, id: randomUUID() };
  const refAbortHash = createHash("sha256").update(refAbortCommand.id).digest("hex");
  const refAbortName = `paws-snapshot-${refAbortHash}`;
  const refAbortPath = join(prepared.mirror, "refs", "heads", refAbortName);
  const refAbort = new AbortController();
  await holdPackedRefs();
  try {
    const preparing = repositories.prepare(refAbortCommand, refAbort.signal);
    assert(await abortOnceExists(refAbortPath, preparing, refAbort));
    await assert.rejects(preparing, { name: "AbortError" });
    assert.equal(calls.at(-1)?.signal, refAbort.signal);
    assert.equal(existsSync(refAbortPath), false);
    assert.equal(existsSync(join(options.root, `snapshot-${refAbortHash}.bundle`)), false);
  } finally {
    await releasePackedRefs();
  }
  observe(
    "snapshot cleanup failures and aborts during ref creation leave no disposable bundle",
    true,
    {
      failedCleanupSnapshotRemoved: true,
      refCreationAbortRemovedRef: true,
    },
  );
  assert(!JSON.stringify(command).includes("fixture-read"));
  assert(!JSON.stringify(command).includes("fixture-write"));
  assert(!JSON.stringify(calls.map((call) => call.args)).includes("fixture-read"));
  const actualArgv = readFileSync(`${gitBin}.jsonl`, "utf8");
  assert(actualArgv.includes('"push"'));
  assert(!actualArgv.includes("fixture-read") && !actualArgv.includes("fixture-write"));
  observe(
    "missing bases and interrupted snapshots fail closed without credentials in jobs or recorded production Git argv",
    true,
    {
      missingBaseDenied: true,
      interruptedSnapshotRemoved: true,
      credentialFreeJob: true,
      productionArgvCaptured: true,
    },
  );
}
