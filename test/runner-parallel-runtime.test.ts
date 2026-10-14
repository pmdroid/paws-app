import { expect, test } from "bun:test";
import { tempHome } from "./helpers";
import { probeParallelRuntime } from "./local/runner-parallel-runtime";

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "configured runner capacity admits independent jobs and cancellation only joins its own worker",
  async () => {
    expect(await probeParallelRuntime(tempHome())).toHaveLength(3);
  },
);
