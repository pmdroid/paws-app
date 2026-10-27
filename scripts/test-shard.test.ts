import { expect, test } from "bun:test";
import { shard, testFiles } from "./test-shard";

test("every test file lands in exactly one shard", () => {
  const files = testFiles().map((path, index) => ({ path, size: (index * 7919) % 5000 }));
  const shards = [0, 1, 2, 3].map((index) => shard(files, index, 4));
  const all = shards.flat();
  expect(all.length).toBe(files.length);
  expect(new Set(all).size).toBe(files.length);
  expect(new Set(all)).toEqual(new Set(files.map((file) => file.path)));
});

test("shards are balanced by size and the same for the same input", () => {
  const files = Array.from({ length: 40 }, (_, index) => ({
    path: `test/f${index}.test.ts`,
    size: 1000 + index * 37,
  }));
  const sizes = [0, 1, 2, 3].map((index) =>
    shard(files, index, 4).reduce(
      (total, path) => total + files.find((file) => file.path === path)!.size,
      0,
    ),
  );
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(1500);
  expect(shard(files, 2, 4)).toEqual(shard([...files].reverse(), 2, 4));
});

test("test files outside node_modules and dist are found", () => {
  const files = testFiles();
  expect(files).toContain("scripts/test-shard.test.ts");
  expect(files.some((path) => path.includes("node_modules/") || path.startsWith("dist/"))).toBe(
    false,
  );
});
