import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerDaemon } from "../runner-daemon";
import { openRunnerHealthRuntime } from "../runner-health-runtime";
import { openRunnerRuntime } from "../runner-runtime";
import { openRunnerCheckRuntime } from "../runner-check-runtime";

export async function runPairedDaemon(
  daemon: RunnerDaemon,
  ids: {
    runnerUid: number;
    runnerGid: number;
    agentUid: number;
    agentGid: number;
    resultsGid: number;
    inputGid: number;
    checkUid: number;
    checkGid: number;
  },
  verifierPublicKeyPem: string,
  signal: AbortSignal,
  report: () => void,
): Promise<void> {
  signal.throwIfAborted();
  if (daemon.status().phase !== "paired") throw new Error("Runner must be paired");
  const root = "/var/lib/paws-runner";
  for (const name of ["runtime", "health", "checks", "repositories"]) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.uid !== ids.runnerUid || (info.mode & 0o7777) !== 0o700)
      throw new Error("Runner runtime directory must be private");
  }
  const shared = {
    daemon,
    spool: { root: "/var/lib/paws-runner-spool", runnerUid: ids.runnerUid, agentGid: ids.agentGid },
    results: {
      root: "/var/lib/paws-agent-results",
      agentUid: ids.agentUid,
      resultsGid: ids.resultsGid,
    },
    onError: report,
  };
  const runtime = await openRunnerRuntime({
    ...shared,
    root: join(root, "runtime"),
    repositoryRoot: join(root, "repositories"),
    home: root,
    concurrency: daemon.capacity(),
  });
  let health: Awaited<ReturnType<typeof openRunnerHealthRuntime>> | undefined;
  let check: Awaited<ReturnType<typeof openRunnerCheckRuntime>> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const results = await Promise.allSettled([runtime.stop(), health?.stop(), check?.stop()]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Runner shutdown failed");
    })());
  const interrupt = () => {
    void stop().catch(report);
  };
  try {
    signal.throwIfAborted();
    health = await openRunnerHealthRuntime({ ...shared, root: join(root, "health") });
    signal.throwIfAborted();
    check = await openRunnerCheckRuntime({
      root: join(root, "checks"),
      daemon,
      paths: {
        inputRoot: "/var/lib/paws-check-input",
        workRoot: "/var/lib/paws-check-attempts",
        resultRoot: "/var/lib/paws-check-results",
        runnerUid: ids.runnerUid,
        runnerGid: ids.runnerGid,
        inputGid: ids.inputGid,
        checkUid: ids.checkUid,
        checkGid: ids.checkGid,
      },
      repositoryRoot: join(root, "repositories"),
      home: root,
      verifierPublicKeyPem,
      onError: report,
    });
    signal.throwIfAborted();
    signal.addEventListener("abort", interrupt, { once: true });
    while (!signal.aborted) {
      try {
        await check.tick();
        if (!signal.aborted) await runtime.tick();
        if (!signal.aborted) await health.tick();
      } catch {
        if (!signal.aborted) report();
      }
      await delay(1000, undefined, { signal });
    }
  } finally {
    signal.removeEventListener("abort", interrupt);
    await stop();
  }
}
