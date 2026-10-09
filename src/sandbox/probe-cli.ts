import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { buildCredentialProbe } from "./docker";

/**
 * Manual check: `bun src/sandbox/probe-cli.ts <absolute-worktree>`.
 * The container must print `probe ok: no host credentials`.
 */
export function runCredentialProbe(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const worktree = argv[0];
  if (!worktree) {
    process.stderr.write("usage: bun src/sandbox/probe-cli.ts <absolute-worktree>\n");
    process.exit(2);
  }
  const info = statSync(worktree, { throwIfNoEntry: false });
  if (!info?.isDirectory()) {
    process.stderr.write("worktree must be an existing directory\n");
    process.exit(2);
  }
  const plan = buildCredentialProbe({
    agent: "claude",
    worktree,
    proxyUrl: env.PAWS_SANDBOX_PROXY ?? "http://127.0.0.1:9",
    hostEnv: env,
    ...(env.PAWS_SANDBOX_IMAGE ? { image: env.PAWS_SANDBOX_IMAGE } : {}),
  });
  process.stderr.write(`${plan.bin} ${plan.args.join(" ")}\n`);
  const child = spawn(plan.bin, plan.args, { env: plan.env, stdio: "inherit" });
  child.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.once("exit", (code) => {
    process.exit(code ?? 1);
  });
}

if (import.meta.main) {
  runCredentialProbe(process.argv.slice(2));
}
