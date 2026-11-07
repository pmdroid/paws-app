import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { throwawayEnvironment } from "./throwaway-environment";

const mode = process.argv[2] ?? "check";
if (!["check", "audit", "serve", "workspace", "workspace-serve"].includes(mode)) {
  throw new Error("Usage: bun run verify:local [check|audit|serve|workspace|workspace-serve]");
}
const repo = resolve(import.meta.dir, "..");
const { root, home, env } = throwawayEnvironment();
const kyoto = env.KYOTOAGENT_ROOT;
const bun = realpathSync(process.execPath);
const commands = [
  ...(mode === "check"
    ? [
        ["--bun", "run", "lint"],
        ["--bun", "run", "fmt:check"],
        ["--bun", "run", "typecheck"],
        ["test"],
        ["run", "build:dashboard"],
        ["run", "links"],
      ]
    : mode === "workspace"
      ? []
      : [["run", "build:dashboard"]]),
  [
    mode === "workspace"
      ? "test/local/workspace-instance.ts"
      : mode === "workspace-serve"
        ? process.argv.includes("--settings")
          ? "test/local/settings-ui.ts"
          : "test/local/workspace-ui.ts"
        : "test/local/instance.ts",
    mode,
  ],
];
const gitHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, env });
const gitDiff = Bun.spawnSync(["git", "diff", "HEAD"], { cwd: repo, env });
writeFileSync(
  join(root, "manifest.json"),
  JSON.stringify(
    {
      mode,
      repo,
      home,
      kyoto,
      bun: Bun.version,
      gitSha: gitHead.stdout.toString().trim(),
      trackedDiffSha256: new Bun.CryptoHasher("sha256").update(gitDiff.stdout).digest("hex"),
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
const results: { command: string[]; exit: number }[] = [];
console.log(`Isolated Paws verification: ${root}`);
for (const [index, args] of commands.entries()) {
  const log = join(root, `command-${index + 1}.log`);
  const file = Bun.file(log).writer();
  const child = Bun.spawn([bun, "--no-env-file", ...args], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    force ??= setTimeout(() => child.kill("SIGKILL"), 40_000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const deadline = setTimeout(
    stop,
    mode === "check" && args[0] === "test"
      ? 600_000
      : mode === "serve" || mode === "workspace-serve"
        ? 360_000
        : 300_000,
  );
  async function copy(stream: ReadableStream<Uint8Array>) {
    for await (const chunk of stream) {
      file.write(chunk);
      process.stdout.write(chunk);
    }
  }
  const [exit] = await Promise.all([child.exited, copy(child.stdout), copy(child.stderr)]);
  clearTimeout(deadline);
  clearTimeout(force);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await file.end();
  results.push({ command: args, exit });
  if (exit !== 0 && !existsSync(join(root, "observations.json"))) break;
}
writeFileSync(join(root, "commands.json"), JSON.stringify(results, null, 2));
rmSync(home, { recursive: true, force: true });
rmSync(join(root, "tmp"), { recursive: true, force: true });
console.log(`Evidence retained: ${root}`);
process.exitCode = results.some((result) => result.exit !== 0) ? 1 : 0;
