import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent } from "../../src/acp";
import type { FakeResult, FakeScript } from "../../src/acp/testing/script";

export async function probeHostAcp(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  const dir = join(root, "host-acp");
  const worktree = join(dir, "worktree");
  const pawsRoot = join(dir, "paws");
  const output = join(worktree, "result.txt");
  const blocked = join(pawsRoot, "state", "synthetic-private");
  const scriptPath = join(dir, "script.json");
  const resultPath = join(dir, "agent.json");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(pawsRoot, "state"), { recursive: true });
  writeFileSync(blocked, "synthetic-private-value");
  const script: FakeScript = {
    model: "host-verification-model",
    steps: [
      { type: "fs_read", path: blocked },
      { type: "fs_write", path: output, content: "host ACP completed\n" },
      { type: "end", stopReason: "end_turn" },
    ],
  };
  writeFileSync(scriptPath, JSON.stringify(script));
  const run = await runAgent({
    role: "implementer",
    profile: { agent: "claude", model: "host-verification-model" },
    itemId: "host-acp",
    runId: "host-acp",
    worktreePath: worktree,
    pawsRoot,
    home: process.env.HOME,
    prompt: "Run the scripted host ACP verification.",
    command: process.execPath,
    args: [
      "--no-env-file",
      resolve(import.meta.dir, "../../src/acp/testing/fake-agent.ts"),
      resultPath,
      scriptPath,
    ],
    checkpoint: false,
    timeoutMs: 10_000,
    env: {
      ...process.env,
      GH_TOKEN: "synthetic-github-token",
      SSH_AUTH_SOCK: "/synthetic/ssh-agent.sock",
      AWS_SECRET_ACCESS_KEY: "synthetic-aws-key",
      XAI_API_KEY: "synthetic-model-key",
    },
  });
  const trace = JSON.parse(readFileSync(resultPath, "utf8")) as FakeResult;
  observe(
    "direct host ACP completes while credential environment and guarded reads stay protected",
    run.stopReason === "end_turn" &&
      run.agentExited &&
      readFileSync(output, "utf8") === "host ACP completed\n" &&
      trace.env?.ghToken === false &&
      trace.env.sshAuthSock === false &&
      trace.env.aws === false &&
      trace.env.xaiApiKey === false &&
      trace.fs.some((request) => request.op === "read" && request.path === blocked && !request.ok),
    { run, environment: trace.env, filesystem: trace.fs },
  );
  for (const args of [["--docker"], ["login", "claude", "--docker"]]) {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", resolve(import.meta.dir, "../../src/index.ts"), ...args],
      { env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      observe("removed container command fails before starting Paws", exit === 1 && stdout === "", {
        args,
        exit,
        stdout,
        stderr,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
