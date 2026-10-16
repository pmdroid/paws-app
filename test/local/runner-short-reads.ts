import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function buildShortReadProbe(outdir: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "runner-short-reads-process.ts")],
    outdir,
    target: "bun",
    plugins: [
      {
        name: "bounded-native-read-fixture",
        setup(build) {
          build.onLoad(
            { filter: /(?:spool|results|runner-short-reads-process)\.ts$/ },
            async (args) => ({
              contents: (await Bun.file(args.path).text()).replaceAll(
                '"node:fs"',
                '"short-native-fs"',
              ),
              loader: "ts",
            }),
          );
          build.onResolve({ filter: /^short-native-fs$/ }, () => ({
            path: "fs",
            namespace: "short-read",
          }));
          build.onLoad({ filter: /.*/, namespace: "short-read" }, () => ({
            contents: `
const native = import.meta.require("node:fs");
export const { chmodSync, chownSync, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } = native;
const nativeReadSync = native.readSync;
let seen = new WeakSet();
let allocatedBytes = 0;
let reads = 0;
globalThis.shortReadMetrics = {
  reset() { seen = new WeakSet(); allocatedBytes = 0; reads = 0; },
  snapshot() { return { allocatedBytes, reads }; }
};
export function readSync(fd, buffer, offset, length, position) {
  if (!seen.has(buffer.buffer)) {
    seen.add(buffer.buffer);
    allocatedBytes += buffer.buffer.byteLength;
  }
  reads++;
  return nativeReadSync(fd, buffer, offset, Math.min(length, 257), position);
}`,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "Short-read probe build failed");
  return built.outputs[0]!.path;
}

export async function probeShortReads() {
  const root = mkdtempSync(join(tmpdir(), "paws-short-read-build-"));
  try {
    const entry = await buildShortReadProbe(root);
    const child = Bun.spawn([process.execPath, "--no-env-file", entry], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Short-read probe failed: ${stderr}`);
    const result = JSON.parse(stdout) as {
      privileged: boolean;
      root: string;
      job: { allocatedBytes: number; reads: number };
    };
    rmSync(result.root, { recursive: true, force: true });
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === "build") console.log(await buildShortReadProbe(process.argv[3]!));
  else console.log(JSON.stringify(await probeShortReads()));
}
