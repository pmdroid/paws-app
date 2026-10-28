import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  ensureLayout,
  loadConfigFile,
  parseConfigToml,
  pawsPaths,
  renderMemberVmSettings,
  writeConfigFile,
} from "../src/config";
import { tempHome } from "./helpers";

describe("[member_vm]", () => {
  test("a missing section or key leaves the size to exe.dev", () => {
    expect(parseConfigToml("").memberVm).toBeUndefined();
    expect(parseConfigToml("[member_vm]\ncpu = 4\n").memberVm).toEqual({ cpu: 4 });
    expect(renderMemberVmSettings(undefined)).toBe("");
    expect(renderMemberVmSettings({})).toBe("");
  });

  test("valid values round-trip", () => {
    const text =
      '[member_vm]\ncpu = 8 # vCPUs\nmemory_gb = 16\ndisk_gb = 100\nimage = "ubuntu:24.04"\n';
    const size = parseConfigToml(text).memberVm;
    expect(size).toEqual({ cpu: 8, memoryGb: 16, diskGb: 100, image: "ubuntu:24.04" });
    const rendered = renderMemberVmSettings(size);
    expect(rendered).toBe(
      '\n[member_vm]\ncpu = 8\nmemory_gb = 16\ndisk_gb = 100\nimage = "ubuntu:24.04"\n',
    );
    expect(parseConfigToml(rendered).memberVm).toEqual(size);
  });

  test("pool round-trips next to the size and must be a pool name", () => {
    const text = '[member_vm]\ncpu = 4\npool = "build-eu_2"\n';
    const size = parseConfigToml(text).memberVm;
    expect(size).toEqual({ cpu: 4, pool: "build-eu_2" });
    const rendered = renderMemberVmSettings(size);
    expect(rendered).toBe('\n[member_vm]\ncpu = 4\npool = "build-eu_2"\n');
    expect(parseConfigToml(rendered).memberVm).toEqual(size);
    expect(parseConfigToml('[member_vm]\npool = "build"\n').memberVm).toEqual({ pool: "build" });
    for (const line of [
      "pool = 3",
      'pool = ""',
      'pool = "build --cpu=64"',
      'pool = "-build"',
      'pool = "build;rm"',
      `pool = "${"p".repeat(64)}"`,
    ])
      expect(() => parseConfigToml(`[member_vm]\n${line}\n`)).toThrow(
        "config.toml line 2 member_vm.pool must be an exe.dev pool name",
      );
  });

  test("setup rewrites keep the section", () => {
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    writeFileSync(paths.configFile, "[member_vm]\ncpu = 4\nmemory_gb = 8\n", { mode: 0o600 });
    writeConfigFile(paths.configFile, {
      linearTeam: "ENG",
      linearTeamId: "team",
      linearViewerId: "human",
      linearSecret: "secrets/linear-api-key",
      linearClientFile: null,
      githubAuth: "app",
      repo: "acme/one",
      checkout: paths.home,
      maxTurns: 40,
      maxAwakeMs: 1_000,
      implementer: "claude",
    });
    expect(loadConfigFile(paths.configFile).memberVm).toEqual({ cpu: 4, memoryGb: 8 });
  });

  test("invalid values are refused with their line", () => {
    const cases: [string, string][] = [
      ["cpu = -2", "config.toml line 3 member_vm.cpu must be a whole number from 1 to 512"],
      ["cpu = 0", "config.toml line 3 member_vm.cpu must be a whole number from 1 to 512"],
      ['cpu = "4"', "config.toml line 3 member_vm.cpu must be a whole number from 1 to 512"],
      ["memory_gb = true", "config.toml line 3 member_vm.memory_gb must be a whole number"],
      ["memory_gb = 8GB", "config.toml line 3 has an unsupported value"],
      ["disk_gb = 1.5", "config.toml line 3 has an unsupported value"],
      ["disk_gb = 1000000", "config.toml line 3 member_vm.disk_gb must be a whole number"],
      ["image = 22", "config.toml line 3 member_vm.image must be an image name"],
      ['image = "x --cpu=64"', "config.toml line 3 member_vm.image must be an image name"],
      ["cpus = 4", "config.toml line 3 has an unknown key: member_vm.cpus"],
      ["size = 4", "config.toml line 3 has an unknown key: member_vm.size"],
    ];
    for (const [line, message] of cases)
      expect(() => parseConfigToml(`[member_vm]\ncpu = 2\n${line}\n`)).toThrow(message);
  });
});
