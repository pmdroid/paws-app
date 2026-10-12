import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGitHubGit } from "../../src/github";

export async function probeGitCancellation(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const gitBin = join(root, "hanging-git");
  const compilation = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      fileURLToPath(new URL("../fixtures/hanging-git.ts", import.meta.url)),
      "--outfile",
      gitBin,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const [compiled, compilationError] = await Promise.all([
    compilation.exited,
    new Response(compilation.stderr).text(),
  ]);
  assert.equal(compiled, 0, compilationError);
  const abort = new AbortController();
  const pending = runGitHubGit({
    operation: "clone",
    remoteUrl: join(root, "origin.git"),
    token: "fixture-read-token",
    cwd: root,
    dest: join(root, "mirror.git"),
    gitBin,
    signal: abort.signal,
  });
  let settled = false;
  let pids: number[] = [];
  const completion = pending
    .then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(`${gitBin}.pids.json`) && Date.now() < deadline) await Bun.sleep(10);
    assert(existsSync(`${gitBin}.pids.json`));
    pids = JSON.parse(readFileSync(`${gitBin}.pids.json`, "utf8")) as number[];
    assert.equal(pids.length, 2);
    assert(pids.every(running));
    const at = Date.now();
    abort.abort();
    const result = await Promise.race([
      completion,
      Bun.sleep(3000).then(() => ({ rejected: false })),
    ]);
    assert(result.rejected);
    while (pids.some(running) && Date.now() - at < 3000) await Bun.sleep(10);
    assert(pids.every((pid) => !running(pid)));
    observe(
      "aborting credentialed Git stops the real command and its SIGTERM-resistant descendant",
      true,
      {
        rejected: result.rejected,
        processCount: pids.length,
        elapsedMs: Date.now() - at,
      },
    );
    const rejected = AbortSignal.abort();
    await assert.rejects(
      runGitHubGit({
        operation: "clone",
        remoteUrl: join(root, "origin.git"),
        token: "fixture-read-token",
        cwd: root,
        dest: join(root, "second.git"),
        gitBin,
        signal: rejected,
      }),
    );
    assert.deepEqual(JSON.parse(readFileSync(`${gitBin}.pids.json`, "utf8")), pids);
    observe(
      "an already expired Git operation fails before spawning or creating credentials",
      true,
      { preAbortedRejected: true, processIdsUnchanged: true },
    );
  } finally {
    abort.abort();
    if (!settled) {
      for (const pid of pids.reverse()) killFixtureProcess(pid, gitBin);
    }
    await completion;
  }
}

function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

function killFixtureProcess(pid: number, binary: string) {
  try {
    if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(binary)) process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
