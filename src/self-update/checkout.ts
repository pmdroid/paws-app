import { existsSync } from "node:fs";
import { join } from "node:path";

/** Why an update did not apply. The checkout is back on the previous commit. */
export class UpdateStepError extends Error {
  constructor(
    readonly step: "checkout" | "install" | "build",
    detail: string,
  ) {
    super(`${STEP_TEXT[step]} failed: ${detail}`);
    this.name = "UpdateStepError";
  }
}

const STEP_TEXT = { checkout: "Checkout", install: "bun install", build: "Dashboard build" };

/** The app directory Paws runs from. */
export interface PawsCheckout {
  head(): Promise<string>;
  /** Fetch `origin/main` and return its commit. */
  fetchMain(): Promise<string>;
  /** True when `ancestor` is reachable from `descendant`. */
  contains(descendant: string, ancestor: string): Promise<boolean>;
  /** Move to `target`, install and build the dashboard. On failure, return to the previous commit and throw `UpdateStepError`. */
  apply(target: string): Promise<void>;
}

type Command = (argv: string[], cwd: string) => Promise<{ code: number; output: string }>;

const spawnCommand: Command = async (argv, cwd) => {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.trim() };
};

/** The last lines of a failed command, enough to say why without flooding the overview. */
function tail(output: string): string {
  const lines = output.split("\n").filter((line) => line.trim());
  return lines.slice(-3).join(" ").slice(-400) || "no output";
}

/** A git checkout of Paws, such as `~/.local/share/paws/app`. Null when `dir` is not one. */
export function gitCheckout(
  dir: string,
  options: { bun?: string; run?: Command } = {},
): PawsCheckout | null {
  if (!existsSync(join(dir, ".git"))) return null;
  const bun = options.bun ?? process.execPath;
  const run = options.run ?? spawnCommand;
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args], dir);
    if (result.code !== 0) throw new Error(tail(result.output));
    return result.output;
  };
  return {
    head: () => git("rev-parse", "HEAD"),
    async fetchMain() {
      await git("fetch", "--quiet", "origin", "main");
      return git("rev-parse", "FETCH_HEAD");
    },
    async contains(descendant, ancestor) {
      const result = await run(["git", "merge-base", "--is-ancestor", ancestor, descendant], dir);
      return result.code === 0;
    },
    async apply(target) {
      const previous = await git("rev-parse", "HEAD");
      try {
        await git("merge", "--ff-only", "--quiet", target);
      } catch (error) {
        throw new UpdateStepError(
          "checkout",
          error instanceof Error ? error.message : "git failed",
        );
      }
      const steps: ["install" | "build", string[]][] = [
        ["install", [bun, "install", "--frozen-lockfile"]],
        ["build", [bun, "run", "build:status"]],
      ];
      for (const [step, argv] of steps) {
        const result = await run(argv, dir);
        if (result.code === 0) continue;
        // `--keep` returns to the old commit without discarding local edits.
        await run(["git", "reset", "--quiet", "--keep", previous], dir);
        await run([bun, "install", "--frozen-lockfile"], dir);
        throw new UpdateStepError(step, tail(result.output));
      }
    },
  };
}

/** In-memory checkout for tests. Set `main` to move `origin/main`, `failStep` to break one step. */
export class FakeCheckout implements PawsCheckout {
  readonly applied: string[] = [];
  failStep: "checkout" | "install" | "build" | null = null;
  constructor(
    public current: string,
    public main: string = current,
    /** Commits in order; a later commit contains every earlier one. */
    readonly history: string[] = [current],
  ) {}
  async head() {
    return this.current;
  }
  async fetchMain() {
    if (!this.history.includes(this.main)) this.history.push(this.main);
    return this.main;
  }
  async contains(descendant: string, ancestor: string) {
    const d = this.history.indexOf(descendant);
    const a = this.history.indexOf(ancestor);
    return d >= 0 && a >= 0 && a <= d;
  }
  async apply(target: string) {
    this.applied.push(target);
    if (this.failStep) throw new UpdateStepError(this.failStep, `${this.failStep} broke`);
    this.current = target;
  }
}
