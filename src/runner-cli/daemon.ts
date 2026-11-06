import { journalCaught, journalRejection } from "../journal";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerDaemon } from "../runner-daemon";
import { openRunnerHealthRuntime } from "../runner-health-runtime";
import { openRunnerRetroRuntime } from "../runner-retro-runtime";
import { createRunnerSkillInstaller, type RunnerAgentUser } from "../runner-execution";
import { openRunnerAgents, openRunnerRuntime } from "../runner-runtime";

export async function runPairedDaemon(
  daemon: RunnerDaemon,
  ids: {
    runnerUid: number;
    agentUid: number;
    pawsAgentUid: number;
    agentGid: number;
    resultsGid: number;
    agentUser: RunnerAgentUser;
  },
  signal: AbortSignal,
  report: (error: Error) => void,
): Promise<void> {
  signal.throwIfAborted();
  if (daemon.status().phase !== "paired") throw new Error("Runner must be paired");
  const root = "/var/lib/paws-runner";
  for (const name of ["runtime", "health", "retro", "repositories", "skills"]) {
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
      runnerUid: ids.runnerUid,
      agentUid: ids.agentUid,
      pawsAgentUid: ids.pawsAgentUid,
      resultsGid: ids.resultsGid,
    },
    agentUser: ids.agentUser,
    onError: report,
  };
  const skills = createRunnerSkillInstaller({
    root: join(root, "skills"),
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
  let retro: Awaited<ReturnType<typeof openRunnerRetroRuntime>> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const results = await Promise.allSettled([runtime.stop(), health?.stop(), retro?.stop()]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Runner shutdown failed");
    })());
  const interrupt = () => {
    void stop().catch(journalRejection("runner-cli/daemon.runPairedDaemon.stop", report, null));
  };
  try {
    signal.throwIfAborted();
    health = await openRunnerHealthRuntime({ ...shared, root: join(root, "health") });
    signal.throwIfAborted();
    retro = await openRunnerRetroRuntime({ ...shared, root: join(root, "retro") });
    signal.throwIfAborted();
    signal.addEventListener("abort", interrupt, { once: true });
    while (!signal.aborted) {
      try {
        if (!signal.aborted) await runtime.tick();
        if (!signal.aborted) await health.tick();
        if (!signal.aborted) await retro.tick();
      } catch (error) {
        journalCaught(error, "daemon.runPairedDaemon.tick", null);
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
