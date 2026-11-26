import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boatTokenPath,
  configFromSections,
  ensureLayout,
  memberVmKeyReadable,
  parseConfigToml,
  pawsPaths,
  memberVmSection,
  vmProviderTokenStatus,
  vmSizeFor,
} from "../src/config";
import { removeSecret, writeSecretFile } from "../src/credentials";

describe("[vm_sizes]", () => {
  test("each provider keeps its own size, and the settings round-trip", () => {
    expect(parseConfigToml("").vmSizes).toBeUndefined();
    expect(memberVmSection({ offProviders: [], sizes: {} })).toBeUndefined();
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
    expect(configFromSections({ vm_sizes: memberVmSection(settings) }).vmSizes).toEqual(settings);
  });

  test("invalid values are refused with their key", () => {
    const cases: [string, string, string][] = [
      ["exe-dev", "cpu = 0", "vm_sizes.cpu must be a whole number from 1 to 512"],
      ["exe-dev", "cpus = 4", "have an unknown key: vm_sizes.exe-dev.cpus"],
      ["instabox", "disk_gb = 20", "have an unknown key: vm_sizes.instabox.disk_gb"],
    ];
    for (const [provider, line, message] of cases)
      expect(() => parseConfigToml(`[vm_sizes.${provider}]\n${line}\n`)).toThrow(
        `Saved settings ${message}`,
      );
    expect(() => parseConfigToml('[vm_sizes]\nprovider = "aws"\n')).toThrow(
      "vm_sizes.provider must be exe-dev, boat or instabox",
    );
    expect(() => parseConfigToml("[vm_sizes.aws]\ncpu = 2\n")).toThrow("unknown section");
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
