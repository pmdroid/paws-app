import { afterEach, expect, spyOn, test } from "bun:test";
import { OwnedProcess } from "../process";
import { controlledGit } from "./controlled-git";

const realExecPath = process.execPath;
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
});

const version = () =>
  controlledGit("git", ["--version"], {
    cwd: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
  });

test.skipIf(process.platform !== "linux")(
  "an anchor that never started fails with its spawn error, and the next call succeeds",
  async () => {
    Object.defineProperty(process, "execPath", {
      value: "/nonexistent/paws-anchor",
      configurable: true,
    });
    const failed = await version().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain("ENOENT");
    Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    expect((await version()).stdout).toStartWith("git version");
  },
);

test.skipIf(process.platform !== "linux")(
  "a stop that could not be verified fails only that call",
  async () => {
    const stop = spyOn(OwnedProcess.prototype, "stop").mockResolvedValueOnce(false);
    try {
      await expect(version()).rejects.toThrow("Git process cleanup could not be verified");
      expect((await version()).stdout).toStartWith("git version");
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      stop.mockRestore();
    }
  },
);
