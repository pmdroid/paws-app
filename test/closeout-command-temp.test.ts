import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRunner } from "../src/closeout-spec/run";

test("concurrent checks isolate temp variables and clean up after success, failure and timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-command-temp-test-"));
  try {
    const runner = createCommandRunner({ env: { ...process.env, TMPDIR: root, HOME: root } });
    const paths = await Promise.all(
      [0, 1, 2].map(async (mode) => {
        const logFile = join(root, `${mode}.log`);
        const result = await runner.runLogged({
          cwd: root,
          argv: [
            "sh",
            "-c",
            `printf '%s\\n' "$TMPDIR" "$TMP" "$TEMP" "$HOME"; test -d "$TMPDIR" || exit 3; sleep ${mode === 2 ? 30 : 0.1}; exit ${mode}`,
          ],
          timeoutSeconds: mode === 2 ? 1 : 5,
          expectedHead: "",
          logFile,
          artifactPath: logFile,
        });
        expect(result.timedOut).toBe(mode === 2);
        if (mode !== 2) expect(result.exitCode).toBe(mode);
        const [temp, tmp, temporary, home] = readFileSync(logFile, "utf8").split("\n").slice(1);
        expect(temp).toBeTruthy();
        expect(temp).not.toBe(root);
        expect(tmp).toBe(temp);
        expect(temporary).toBe(temp);
        expect(home).toBe(root);
        expect(existsSync(temp!)).toBe(false);
        return temp;
      }),
    );
    expect(new Set(paths).size).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command check fails clearly when its private temp directory cannot be created", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-command-temp-error-"));
  try {
    // Isolate process.env so other concurrent tests retain their scratch location.
    const modulePath = join(import.meta.dir, "../src/closeout-spec/run/index.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const { createCommandRunner } = await import(${JSON.stringify(modulePath)});
      try {
        const result = await createCommandRunner({ logDir: ${JSON.stringify(root)} }).run({ cwd: ${JSON.stringify(root)}, argv: ["sh", "-c", "exit 0"], timeoutSeconds: 5 });
        console.error(require("node:fs").readFileSync(result.artifacts[0].path, "utf8"));
        process.exit(result.exitCode === null && !result.timedOut ? 1 : 2);
      } catch (error) { console.error(error.message); process.exit(1); }
    `,
      ],
      { env: { ...process.env, TMPDIR: join(root, "missing") }, stdout: "pipe", stderr: "pipe" },
    );
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(error).toContain("Could not prepare Closeout command check");
    expect(error).toContain("ENOENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
