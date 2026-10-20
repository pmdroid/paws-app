import { expect, test } from "bun:test";
import { loadMemberVmConfig } from "../src/config";
const MISE_VERSION = "2026.10.15";
test("automatic VM configuration is explicit, validated and has no resource defaults", () => {
  const env = { home: "/srv/paws" } as Parameters<typeof loadMemberVmConfig>[1];
  const complete = {
    PAWS_MEMBER_VM_PROVIDER: "exe.dev",
    PAWS_MEMBER_VM_CPU: "2",
    PAWS_MEMBER_VM_MEMORY_GB: "8",
    PAWS_MEMBER_VM_RUNNER_VERSION: "1.2.3",
    PAWS_MEMBER_VM_RUNNER_API_URL: "https://runner.example.invalid:8788",
    PAWS_MEMBER_VM_MISE_VERSION: MISE_VERSION,
    PAWS_MEMBER_VM_MISE_SHA256_AMD64: "c".repeat(64),
  };
  expect(loadMemberVmConfig({}, env)).toBeNull();
  expect(loadMemberVmConfig(complete, env)).toEqual({
    provider: "exe.dev",
    tokenFile: "/srv/paws/secrets/exe-dev-token",
    resources: { cpu: 2, memoryGB: 8 },
    runnerVersion: "1.2.3",
    runnerApiUrl: "https://runner.example.invalid:8788",
    mise: { version: MISE_VERSION, sha256: { amd64: "c".repeat(64) } },
  });
  expect(
    loadMemberVmConfig(
      {
        ...complete,
        PAWS_MEMBER_VM_POOL: "team-pool",
        PAWS_MEMBER_VM_TOKEN_FILE: "/run/secrets/exe",
        PAWS_MEMBER_VM_SERVER_CA_FILE: "ca.pem",
      },
      env,
    ),
  ).toMatchObject({
    tokenFile: "/run/secrets/exe",
    serverCaFile: "/srv/paws/ca.pem",
    resources: { cpu: 2, memoryGB: 8, pool: "team-pool" },
  });
  expect(() => loadMemberVmConfig({ PAWS_MEMBER_VM_CPU: "2" }, env)).toThrow(
    "PAWS_MEMBER_VM_CPU requires PAWS_MEMBER_VM_PROVIDER=exe.dev.",
  );
  for (const name of [
    "PAWS_MEMBER_VM_CPU",
    "PAWS_MEMBER_VM_MEMORY_GB",
    "PAWS_MEMBER_VM_RUNNER_VERSION",
    "PAWS_MEMBER_VM_RUNNER_API_URL",
    "PAWS_MEMBER_VM_MISE_VERSION",
    "PAWS_MEMBER_VM_MISE_SHA256_AMD64",
  ]) {
    const partial: Record<string, string | undefined> = { ...complete };
    delete partial[name];
    expect(() => loadMemberVmConfig(partial, env)).toThrow();
  }
  for (const [name, value] of [
    ["PAWS_MEMBER_VM_PROVIDER", "aws"],
    ["PAWS_MEMBER_VM_CPU", "0"],
    ["PAWS_MEMBER_VM_MEMORY_GB", "4.5"],
    ["PAWS_MEMBER_VM_RUNNER_VERSION", "latest"],
    ["PAWS_MEMBER_VM_RUNNER_API_URL", "http://runner.example.invalid"],
    ["PAWS_MEMBER_VM_RUNNER_API_URL", "https://runner.example.invalid/path"],
    ["PAWS_MEMBER_VM_MISE_VERSION", "latest"],
    ["PAWS_MEMBER_VM_MISE_SHA256_AMD64", "C".repeat(64)],
    ["PAWS_MEMBER_VM_POOL", "Bad Pool"],
  ])
    expect(() => loadMemberVmConfig({ ...complete, [name!]: value }, env)).toThrow();
});
