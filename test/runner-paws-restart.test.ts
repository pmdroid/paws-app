import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Startup spies belong to a separate process, away from parallel test files.
test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "Paws.stop preserves a real runner mid-implementation, mid-review and mid-answer",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-restart-e2e-"));
    try {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "test/fixtures/runner-paws-restart.ts", root],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 55_000,
        },
      );
      const [exit, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, output + errors).toBe(0);
      expect(output).toContain("restart integration passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

for (const stop of ["crash", "graceful"]) {
  for (const phase of ["preparing", "running"]) {
    test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
      `runner ${stop} during ${phase} recovers from its branch through the real runtime`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "paws-runner-restart-e2e-"));
        try {
          const child = Bun.spawn(
            [
              process.execPath,
              "--no-env-file",
              "test/fixtures/runner-paws-restart.ts",
              root,
              stop,
              phase,
            ],
            {
              env: {
                PATH: process.env.PATH,
                HOME: root,
                DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
              },
              stdout: "pipe",
              stderr: "pipe",
              timeout: 55_000,
            },
          );
          const [exit, output, errors] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(exit, output + errors).toBe(0);
          expect(output).toContain("runner restart integration passed");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
}
