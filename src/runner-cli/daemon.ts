import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerDaemon } from "../runner-daemon";
import { openRunnerHealthRuntime } from "../runner-health-runtime";
import { createRunnerSkillInstaller } from "../runner-execution";
import { openRunnerAgents, openRunnerRuntime } from "../runner-runtime";

export async function runPairedDaemon(
  daemon: RunnerDaemon,
  ids: {
    runnerUid: number;
    agentUid: number;
    agentGid: number;
    resultsGid: number;
  },
  signal: AbortSignal,
  report: (error: Error) => void,
): Promise<void> {
  signal.throwIfAborted();
  if (daemon.status().phase !== "paired") throw new Error("Runner must be paired");
  const root = "/var/lib/paws-runner";
  for (const name of ["runtime", "health", "repositories", "skills"]) {
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
  const skills = createRunnerSkillInstaller({
    root: join(root, "skills"),
    owner: { uid: ids.agentUid, gid: process.getgid?.() ?? ids.agentUid },
    download: (skill) => daemon.downloadSkill(skill),
    onError: report,
  });
  const runtime = await openRunnerRuntime({
    ...shared,
    root: join(root, "runtime"),
    repositoryRoot: join(root, "repositories"),
    home: root,
    skills,
    agents: openRunnerAgents({ onError: report }),
    concurrency: () => daemon.capacity(),
  });
  let health: Awaited<ReturnType<typeof openRunnerHealthRuntime>> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const results = await Promise.allSettled([runtime.stop(), health?.stop()]);
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
    signal.addEventListener("abort", interrupt, { once: true });
    while (!signal.aborted) {
      try {
        if (!signal.aborted) await runtime.tick();
        if (!signal.aborted) await health.tick();
      } catch (error) {
        if (!signal.aborted)
          report(error instanceof Error ? error : new Error("Runner operation failed"));
      }
      await delay(1000, undefined, { signal });
    }
  } finally {
    signal.removeEventListener("abort", interrupt);
    await stop();
  }
}
