import { statSync } from "node:fs";

const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIPPED = /(^|\/)(node_modules|dist|\.git)\//;

export function testFiles(root = "."): string[] {
  return [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })]
    .filter((path) => TEST_FILE.test(path) && !SKIPPED.test(path))
    .sort();
}

export function shard(
  files: readonly { path: string; size: number }[],
  index: number,
  count: number,
): string[] {
  const loads = Array.from({ length: count }, () => ({ size: 0, paths: [] as string[] }));
  const ordered = [...files].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  for (const file of ordered) {
    const lightest = loads.reduce((best, load) => (load.size < best.size ? load : best));
    lightest.size += file.size;
    lightest.paths.push(file.path);
  }
  return loads[index]!.paths.sort();
}

if (import.meta.main) {
  const [index, count] = process.argv.slice(2).map(Number);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    count < 1 ||
    index! < 0 ||
    index! >= count!
  )
    throw new Error("usage: bun scripts/test-shard.ts <index> <count>");
  const files = testFiles().map((path) => ({ path, size: statSync(path).size }));
  console.log(
    shard(files, index!, count!)
      .map((path) => `./${path}`)
      .join("\n"),
  );
}
