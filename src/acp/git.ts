import { spawn } from "node:child_process";
import { spawnAgent, stopChild } from "./process";

export class GitError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (${code ?? "signal"}): ${stderr.trim() || "no stderr"}`);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export async function git(
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onCleanupFailure?: () => void;
  },
): Promise<string> {
  options?.signal?.throwIfAborted();
  const ownedChild = options?.signal
    ? spawnAgent(
        "git",
        args,
        Object.fromEntries(
          Object.entries(options.env ?? process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        { cwd: options.cwd },
      )
    : null;
  const nativeChild = ownedChild
    ? null
    : spawn("git", args, {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
  const child = ownedChild ?? nativeChild!;
  ownedChild?.stdin?.end();
  const cleanup = () => (ownedChild ? stopChild(ownedChild, 500) : Promise.resolve(true));
  let stopping: Promise<boolean> | undefined;
  const abort = () => {
    stopping ??= cleanup();
  };
  options?.signal?.addEventListener("abort", abort, { once: true });
  let result: string | undefined;
  let failed = false;
  let failure: unknown;
  try {
    result = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const closed = (code: number | null) => {
        if (code === 0) resolve(stdout);
        else reject(new GitError(args, code, stderr));
      };
      if (ownedChild) {
        ownedChild.on("error", reject);
        ownedChild.on("close", closed);
      } else {
        nativeChild!.on("error", reject);
        nativeChild!.on("close", closed);
      }
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    options?.signal?.removeEventListener("abort", abort);
  }
  if (options?.signal && !(await (stopping ?? cleanup()))) {
    options.onCleanupFailure?.();
    throw new Error("Git process cleanup could not be verified");
  }
  options?.signal?.throwIfAborted();
  if (failed) throw failure;
  return result!;
}
