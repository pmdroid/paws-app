import { OwnedProcess } from "../process";
import { GitCommandError } from "./types";

export async function controlledGit(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) {
  const signal = options.signal!;
  signal.throwIfAborted();
  const child = new OwnedProcess(
    binary,
    args,
    Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    options.cwd,
  );
  child.stdin?.end();
  let stopping: Promise<boolean> | undefined;
  let rejectCancellation: (error: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => {
    stopping ??= child.stop(500);
    void stopping.then(
      () => rejectCancellation(signal.reason ?? new Error("Git operation aborted")),
      rejectCancellation,
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputExceeded = false;
  let cleanupVerified = false;
  let failed = false;
  let failure: unknown;
  try {
    const completed = new Promise<void>((resolve, reject) => {
      const read = (name: "stdout" | "stderr", chunk: string) => {
        if (outputExceeded) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 10 * 1024 * 1024) {
          outputExceeded = true;
          stopping ??= child.stop(500);
          reject(new Error("Git output exceeds limit"));
          return;
        }
        if (name === "stdout") stdout += chunk;
        else stderr += chunk;
      };
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => read("stdout", chunk));
      child.stderr!.on("data", (chunk: string) => read("stderr", chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new GitCommandError(args, stderr)),
      );
    });
    await Promise.race([completed, cancelled]);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    signal.removeEventListener("abort", abort);
    cleanupVerified = await (stopping ?? child.stop(500));
  }
  if (!cleanupVerified) throw new Error("Git process cleanup could not be verified");
  signal.throwIfAborted();
  if (failed) throw failure;
  return { stdout, stderr };
}
