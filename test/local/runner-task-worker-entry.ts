import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runRunnerCli } from "../../src/runner-cli";
import { publishRunnerAnswer } from "../../src/runner-answers";
import { publishRunnerJob, RunnerJobSchema } from "../../src/runner-execution";

const [mode, ...args] = process.argv.slice(2);
if (mode === "agent") {
  const script = "/opt/paws-runner/current/scripts/current.json";
  const { executionId } = JSON.parse(readFileSync(script, "utf8"));
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "/opt/paws-runner/current/fake-agent.js",
      join("/var/lib/paws-agent-tasks", executionId, "agent.json"),
      script,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env },
  );
  process.exit(await child.exited);
} else if (mode === "stage" || mode === "answer") {
  const spool = {
    root: "/var/lib/paws-runner-spool",
    runnerUid: process.getuid!(),
    agentGid: Number(args[0]),
  };
  if (mode === "stage") {
    const job = RunnerJobSchema.parse(JSON.parse(readFileSync(args[1]!, "utf8")));
    publishRunnerJob(spool, job, args[2] ? { repositorySnapshot: args[2] } : {});
  } else {
    publishRunnerAnswer(spool, args[1]!, { requestId: args[2]!, answer: args[3]! });
  }
} else {
  process.exit(await runRunnerCli(process.argv.slice(3)));
}
