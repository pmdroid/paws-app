import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostSlots, loadConfig, runnerConcurrency } from "../src/runner-cli";

describe("hostSlots", () => {
  test("gives one slot per 2 CPUs and 4 GiB, from 1 to 16", () => {
    expect(hostSlots({ cpus: 20, memoryGiB: 121 })).toBe(10);
    expect(hostSlots({ cpus: 4, memoryGiB: 8 })).toBe(2);
    expect(hostSlots({ cpus: 1, memoryGiB: 2 })).toBe(1);
    expect(hostSlots({ cpus: 64, memoryGiB: 512 })).toBe(16);
    expect(hostSlots({ cpus: 12, memoryGiB: 31 })).toBe(6);
    expect(hostSlots({ cpus: 32, memoryGiB: 15 })).toBe(3);
  });
});

describe("runnerConcurrency", () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-runner-host-slots-"));
  const configured = (value: object) => {
    const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(value));
    chmodSync(path, 0o600);
    return loadConfig(path, process.getuid!()).concurrency;
  };
  const base = { controlPlaneUrl: "https://paws.example", runnerApiUrl: "https://runners.example" };
  const host = () => ({ cpus: 12, memoryGiB: 31 });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a config without concurrency sizes slots from the host and logs the inputs", () => {
    const lines: string[] = [];
    expect(runnerConcurrency(configured(base), host, (line) => lines.push(line))).toBe(6);
    expect(lines).toEqual(["runner slots 6 from 12 CPUs and 31 GiB"]);
  });

  test("an explicit concurrency wins without reading the host", () => {
    const lines: string[] = [];
    const unread = () => {
      throw new Error("host read");
    };
    expect(
      runnerConcurrency(configured({ ...base, concurrency: 2 }), unread, (line) =>
        lines.push(line),
      ),
    ).toBe(2);
    expect(lines).toEqual([]);
  });
});
