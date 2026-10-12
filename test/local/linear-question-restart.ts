import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function probeLinearQuestionRestart(root: string): Promise<{
  question: { id: string; status: string; answer: string; answeredBy: string };
  item: { state: string };
  jobs: { queue: string; payload: { handoff?: string } }[];
  resumed: unknown[];
  duplicates: unknown[];
  stoppedPid: number;
  stoppedExit: number;
}> {
  mkdirSync(root, { recursive: true });
  const env = {
    HOME: root,
    PAWS_HOME: join(root, "home"),
    KYOTOAGENT_ROOT: join(root, "kyoto"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  const fixture = resolve(import.meta.dir, "../fixtures/linear-question-restart.ts");
  const first = Bun.spawn([process.execPath, "--no-env-file", fixture, "ask", root], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => first.kill("SIGKILL"), 5_000);
  try {
    const ready = join(root, "ready.json");
    while (!existsSync(ready)) {
      if (first.exitCode !== null)
        throw new Error(
          `Question process exited before parking: ${await new Response(first.stderr).text()}`,
        );
      await Bun.sleep(10);
    }
    JSON.parse(readFileSync(ready, "utf8"));
    first.kill("SIGTERM");
    const stoppedExit = await first.exited;
    const second = Bun.spawn([process.execPath, "--no-env-file", fixture, "answer", root], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stopSecond = setTimeout(() => second.kill("SIGKILL"), 5_000);
    try {
      const [exit, output, error] = await Promise.all([
        second.exited,
        new Response(second.stdout).text(),
        new Response(second.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`Restarted question process exited ${exit}: ${error}`);
      return { ...JSON.parse(output), stoppedPid: first.pid, stoppedExit };
    } finally {
      clearTimeout(stopSecond);
    }
  } finally {
    clearTimeout(timeout);
    if (first.exitCode === null) {
      first.kill("SIGKILL");
      await first.exited;
    }
  }
}
