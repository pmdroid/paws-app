import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeRunnerWorker } from "./local/runner-worker";

test("worker publications stay hidden until ownership is ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-publication-"));
  const source = fileURLToPath(new URL("../src/runner-worker/index.ts", import.meta.url));
  const dependencies = ["acp", "runner-execution", "runner-answers", "install"].map((name) => ({
    name,
    path: fileURLToPath(new URL(`../src/${name}/index.ts`, import.meta.url)),
  }));
  const observations: string[] = [];
  let instrumented = false;
  try {
    const build = await Bun.build({
      entrypoints: [source],
      target: "bun",
      outdir: join(root, "compiled"),
      naming: "worker.mjs",
      external: dependencies.map((entry) => entry.path),
      plugins: [
        {
          name: "observe-publication",
          setup(builder) {
            builder.onLoad({ filter: /runner-worker\/index\.ts$/ }, async ({ path }) => {
              const original = dependencies.reduce(
                (contents, entry) =>
                  contents.replace(`from "../${entry.name}"`, `from ${JSON.stringify(entry.path)}`),
                await Bun.file(path).text(),
              );
              const ownership = "    fchownSync(fd, process.getuid!(), resultsGid);";
              assert.equal(original.split(ownership).length - 1, 1);
              instrumented = true;
              return {
                loader: "ts",
                contents: original.replace(
                  ownership,
                  `    if (name === "result.json" || name.startsWith(".result-") || name === "events.jsonl" || name.startsWith(".events-")) {
      try {
        const visible = openSync(join(directory, name.includes("result") ? "result.json" : "events.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
        closeSync(visible);
        throw new Error("Runner publication visible before ownership assignment");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
` + ownership,
                ),
              };
            });
          },
        },
      ],
    });
    assert(build.success, JSON.stringify(build.logs));
    assert(instrumented);
    const worker = await import(pathToFileURL(build.outputs[0]!.path).href);
    await probeRunnerWorker(
      join(root, "probe"),
      (name, passed) => {
        assert(passed, name);
        observations.push(name);
      },
      worker.executeRunnerCommand,
    );
    assert.equal(observations.length, 17);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
