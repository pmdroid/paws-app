import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createMemberVmProvisioning,
  type MemberVmProvisioningSource,
  type MemberVmRunnerControl,
} from "../src/member-vm";
import { createFakeExeDev, isBootstrapError, PINNED_MISE } from "../src/provisioning";

const INSTALLER = readFileSync(
  new URL("../deploy/linux/install-runner.sh", import.meta.url),
  "utf8",
);
const VM = "ada-paws";

function source(overrides: Partial<MemberVmProvisioningSource> = {}) {
  const exeDev = createFakeExeDev();
  exeDev.addVm(VM);
  exeDev.scriptExec(VM, /.*/, {});
  const minted: string[] = [];
  const control: MemberVmRunnerControl = {
    port: 8788,
    serverVersion: "1.4.0",
    mintEnrollment: (member) => {
      minted.push(member.userId);
      return { token: "t".repeat(43), expiresAt: 1 };
    },
  };
  const value: MemberVmProvisioningSource = {
    readToken: () => null,
    installer: () => INSTALLER,
    publicUrl: "https://paws.example.invalid",
    repositories: () => ["acme/app"],
    runnerControl: async () => control,
    exeDev,
    ...overrides,
  };
  return { value, exeDev, minted, control };
}

test("the pinned mise release matches the one the runner package ships", () => {
  const release = readFileSync(new URL("../deploy/linux/release.py", import.meta.url), "utf8");
  const version = /^MISE_VERSION = "([^"]+)"/m.exec(release)?.[1];
  for (const platform of ["linux-x64", "linux-arm64"] as const) {
    const sha = new RegExp(`"${platform}": "([0-9a-f]{64})"`).exec(release)?.[1];
    expect(PINNED_MISE[platform]).toEqual({ version: version!, sha256: sha!, platform });
  }
});

test("each missing prerequisite is named before any exe.dev call", async () => {
  const cases: [Partial<MemberVmProvisioningSource>, RegExp][] = [
    [{ publicUrl: null }, /PAWS_PUBLIC_URL/],
    [{ runnerControl: async () => null }, /runner control/],
    [
      {
        runnerControl: async () => ({
          port: 8788,
          serverVersion: null,
          mintEnrollment: () => ({ token: "x", expiresAt: 0 }),
        }),
      },
      /installed Paws release/,
    ],
    [{ installer: () => null }, /install-runner\.sh/],
  ];
  for (const [overrides, message] of cases) {
    const { value, exeDev } = source(overrides);
    await expect(createMemberVmProvisioning(value)()).rejects.toThrow(message);
    expect(exeDev.calls).toHaveLength(0);
  }
});

test("the bootstrap points the VM at this Paws and the runner API port", async () => {
  const { value, exeDev, minted } = source();
  const provisioning = await createMemberVmProvisioning(value)();
  provisioning.mintEnrollment({ workspaceId: "w", userId: "u" }, { name: VM });
  expect(minted).toEqual(["u"]);
  const error = await provisioning.bootstrap.startInstall(VM, "t".repeat(43)).catch((e) => e);
  expect(isBootstrapError(error)).toBe(true);
  const staged = exeDev.calls
    .map((call) => (call.operation === "execVm" ? call.command : ""))
    .find((command) => command.includes("controlPlaneUrl"));
  expect(staged).toContain('"controlPlaneUrl":"https://paws.example.invalid"');
  expect(staged).toContain('"runnerApiUrl":"https://paws.example.invalid:8788"');
  expect(staged).toContain('"allowedRepositories":["acme/app"]');
  expect(staged).toContain("'1.4.0'");
});
