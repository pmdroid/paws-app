import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createMemberVmProvisioning,
  type MemberVmProvisioningSource,
  type MemberVmRunnerControl,
} from "../src/member-vm";
import {
  createFakeExeDev,
  isBootstrapError,
  latestRunnerRelease,
  PINNED_MISE,
  PINNED_TAILSCALE,
} from "../src/provisioning";

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
    latestRelease: async () => null,
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
      /latest runner release/,
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

test("a source checkout installs the latest runner release on the VM", async () => {
  const { value, exeDev, control } = source({ latestRelease: async () => "0.1.40" });
  control.serverVersion = null;
  const provisioning = await createMemberVmProvisioning(value)();
  await provisioning.bootstrap.startInstall(VM, "t".repeat(43)).catch(() => undefined);
  const commands = exeDev.calls.map((call) => (call.operation === "execVm" ? call.command : ""));
  expect(commands.some((command) => command.includes("'0.1.40'"))).toBe(true);
});

test("the latest runner release is read from the GitHub release tag", async () => {
  const urls: string[] = [];
  const reply = (status: number, body: unknown) => async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  expect(await latestRunnerRelease(reply(200, { tag_name: "v0.1.40" }))).toBe("0.1.40");
  expect(urls).toEqual(["https://api.github.com/repos/pmdroid/paws-app/releases/latest"]);
  expect(await latestRunnerRelease(reply(200, { tag_name: "nightly" }))).toBeNull();
  expect(await latestRunnerRelease(reply(404, { message: "Not Found" }))).toBeNull();
  expect(
    await latestRunnerRelease(async () => {
      throw new Error("offline");
    }),
  ).toBeNull();
});

test("a Paws on a .ts.net host without a Tailscale auth key is refused before any exe.dev call", async () => {
  for (const publicUrl of [
    "https://agentbox.taile07e4.ts.net:8787",
    "https://AGENTBOX.TAILE07E4.TS.NET",
  ]) {
    const { value, exeDev } = source({ publicUrl, tailscaleAuthKey: () => null });
    await expect(createMemberVmProvisioning(value)()).rejects.toThrow(
      /~\/\.paws\/secrets\/tailscale-authkey/,
    );
    const absent = source({ publicUrl });
    await expect(createMemberVmProvisioning(absent.value)()).rejects.toThrow(/tailscale-authkey/);
    expect(exeDev.calls).toHaveLength(0);
    expect(absent.exeDev.calls).toHaveLength(0);
  }
});

test("a public Paws without an auth key provisions as before and skips the tailnet step", async () => {
  const { value, exeDev } = source({ tailscaleAuthKey: () => null });
  const provisioning = await createMemberVmProvisioning(value)();
  expect(await provisioning.bootstrap.joinTailnet(VM)).toBe("skipped");
  expect(exeDev.calls).toHaveLength(0);
});

test("with an auth key the bootstrap joins the VM to the tailnet with the pinned Tailscale", async () => {
  const { value, exeDev } = source({
    publicUrl: "https://agentbox.taile07e4.ts.net:8787",
    tailscaleAuthKey: () => "tskey-auth-kAbCdEf1CNTRL-0123456789",
  });
  const provisioning = await createMemberVmProvisioning(value)();
  // The catch-all script answers every command with no output, so the join stops at the key.
  await provisioning.bootstrap.joinTailnet(VM).catch(() => undefined);
  const commands = exeDev.calls.map((call) => (call.operation === "execVm" ? call.command : ""));
  expect(commands.some((command) => command.includes(PINNED_TAILSCALE.amd64.sha256))).toBe(true);
  expect(commands.some((command) => command.includes("tskey-"))).toBe(false);
});
