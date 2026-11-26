import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boatTokenPath,
  ensureLayout,
  memberVmKeyReadable,
  parseConfigToml,
  parseVmSizesSettings,
  pawsPaths,
  renderVmSizesSettings,
  upgradeSettingSections,
  vmProviderTokenStatus,
  vmSizeFor,
} from "../src/config";
import { removeSecret, writeSecretFile } from "../src/credentials";

describe("[vm_sizes]", () => {
  test("a missing section or size leaves each provider at its default", () => {
    expect(parseConfigToml("").vmSizes).toBeUndefined();
    expect(vmSizeFor(undefined, "boat")).toEqual({});
    expect(renderVmSizesSettings(undefined)).toBe("");
    expect(renderVmSizesSettings({ offProviders: [], sizes: {} })).toBe("");
  });

  test("each provider keeps its own size, and the settings round-trip", () => {
    const text =
      '[vm_sizes]\nprovider = "boat"\noff_providers = ["instabox"]\n\n[vm_sizes.exe-dev]\ncpu = 8 # vCPUs\nmemory_gb = 16\ndisk_gb = 100\nimage = "ubuntu:24.04"\npool = "build-eu_2"\n\n[vm_sizes.boat]\ncpu = 4\nmemory_gb = 8\n\n[vm_sizes.instabox]\ncpu = 2\nmemory_gb = 4\n';
    const settings = parseConfigToml(text).vmSizes;
    expect(settings).toEqual({
      provider: "boat",
      offProviders: ["instabox"],
      sizes: {
        "exe-dev": { cpu: 8, memoryGb: 16, diskGb: 100, image: "ubuntu:24.04", pool: "build-eu_2" },
        boat: { cpu: 4, memoryGb: 8 },
        instabox: { cpu: 2, memoryGb: 4 },
      },
    });
    expect(vmSizeFor(settings, "boat")).toEqual({ cpu: 4, memoryGb: 8 });
    expect(parseConfigToml(renderVmSizesSettings(settings)).vmSizes).toEqual(settings);
  });

  test("invalid values are refused with their line", () => {
    const cases: [string, string, string][] = [
      ["exe-dev", "cpu = 0", "line 3 vm_sizes.exe-dev.cpu must be a whole number from 1 to 512"],
      ["exe-dev", 'cpu = "4"', "line 3 vm_sizes.exe-dev.cpu must be a whole number"],
      ["exe-dev", "disk_gb = 1000000", "line 3 vm_sizes.exe-dev.disk_gb must be a whole number"],
      ["exe-dev", 'image = "x --cpu=64"', "line 3 vm_sizes.exe-dev.image must be an image name"],
      ["exe-dev", 'pool = "-build"', "line 3 vm_sizes.exe-dev.pool must be an exe.dev pool name"],
      ["exe-dev", "cpus = 4", "line 3 has an unknown key: vm_sizes.exe-dev.cpus"],
      ["boat", 'pool = "build"', "line 3 has an unknown key: vm_sizes.boat.pool"],
      ["instabox", "disk_gb = 20", "line 3 has an unknown key: vm_sizes.instabox.disk_gb"],
    ];
    for (const [provider, line, message] of cases)
      expect(() => parseConfigToml(`[vm_sizes.${provider}]\ncpu = 2\n${line}\n`)).toThrow(
        `Saved settings ${message}`,
      );
    expect(() => parseConfigToml('[vm_sizes]\nprovider = "aws"\n')).toThrow(
      "vm_sizes.provider must be exe-dev, boat or instabox",
    );
    expect(() => parseConfigToml("[vm_sizes.aws]\ncpu = 2\n")).toThrow("unknown section");
  });

  test("a boat size outside boat's sizes is refused with the allowed list", () => {
    expect(() => parseVmSizesSettings({ sizes: { boat: { cpu: 6, memoryGb: 12 } } })).toThrow(
      "boat has no 6 vCPU / 12 GB size. Use 2/4, 4/8, 8/16 or 16/32.",
    );
    expect(() => parseVmSizesSettings({ sizes: { boat: { cpu: 4, diskGb: 20 } } })).toThrow(
      "vm_sizes.boat has an unknown field: diskGb (use cpu, memoryGb)",
    );
    expect(
      parseVmSizesSettings({ sizes: { boat: { cpu: 8, memoryGb: 16 }, instabox: {} } }),
    ).toEqual({ sizes: { boat: { cpu: 8, memoryGb: 16 } } });
  });

  test("an old single size converts to the provider it names, or to exe.dev", () => {
    const old = { cpu: 8, memory_gb: 16, disk_gb: 40, image: "ubuntu:24.04", pool: "build" };
    expect(upgradeSettingSections({ queue: { x: 1 }, member_vm: old })).toEqual({
      queue: { x: 1 },
      vm_sizes: { "exe-dev": old },
    });
    expect(
      upgradeSettingSections({
        member_vm: { ...old, provider: "boat", off_providers: ["instabox"] },
      }),
    ).toEqual({
      vm_sizes: { provider: "boat", off_providers: ["instabox"], boat: { cpu: 8, memory_gb: 16 } },
    });
    expect(upgradeSettingSections({ member_vm: {} })).toEqual({});
    const current = { queue: {} };
    expect(upgradeSettingSections(current)).toBe(current);
  });

  test("Create VM is offered only once the configured provider's key is saved", async () => {
    const home = mkdtempSync(join(tmpdir(), "paws-vm-keys-"));
    try {
      ensureLayout(pawsPaths(home));
      writeSecretFile(join(pawsPaths(home).secretsDir, "exe-dev-token"), "exe1.token");
      expect(memberVmKeyReadable(home, undefined)).toBe(true);
      expect(memberVmKeyReadable(home, { provider: "boat" })).toBe(false);
      expect(vmProviderTokenStatus(home, "boat")).toBe("absent");
      writeSecretFile(boatTokenPath(home), "boat-key\n");
      expect(memberVmKeyReadable(home, { provider: "boat" })).toBe(true);
      expect(memberVmKeyReadable(home, { provider: "instabox" })).toBe(false);
      await removeSecret(boatTokenPath(home));
      expect(memberVmKeyReadable(home, { provider: "boat" })).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
