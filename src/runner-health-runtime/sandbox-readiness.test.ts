import { expect, test } from "bun:test";
import { helperSandboxFailure } from "./sandbox-readiness";

const account = { name: "paws-agent", uid: 983 };
const manager = "/sys/fs/cgroup/user.slice/user-983.slice/user@983.service";
const sysctls = {
  "/proc/sys/user/max_user_namespaces": "63749",
  "/proc/sys/kernel/unprivileged_userns_clone": "1",
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0",
} as Record<string, string>;

const host = (paths: string[], values: Record<string, string> = sysctls) => ({
  exists: (path: string) => paths.includes(path),
  read: (path: string) => values[path] ?? null,
});

test("a running user manager with user namespaces allowed reports nothing", () => {
  expect(helperSandboxFailure(account, host([manager]))).toBeNull();
  expect(helperSandboxFailure(account, host([manager], {}))).toBeNull();
  expect(
    helperSandboxFailure(
      account,
      host(["/sys/fs/cgroup/systemd/user.slice/user-983.slice/user@983.service"]),
    ),
  ).toBeNull();
});

test("a missing user manager names the account and the linger fix", () => {
  expect(helperSandboxFailure(account, host([]))).toBe(
    "Sandboxed helper turns cannot start: paws-agent has no running systemd user manager; run sudo loginctl enable-linger paws-agent.",
  );
});

test("a refused user namespace names the sysctl that refuses it", () => {
  for (const [path, value, name] of [
    ["/proc/sys/user/max_user_namespaces", "0", "user.max_user_namespaces=0"],
    ["/proc/sys/kernel/unprivileged_userns_clone", "0", "kernel.unprivileged_userns_clone=0"],
    [
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      "1",
      "kernel.apparmor_restrict_unprivileged_userns=1",
    ],
  ] as const)
    expect(helperSandboxFailure(account, host([manager], { ...sysctls, [path]: value }))).toBe(
      `Sandboxed helper turns cannot start: The kernel refuses unprivileged user namespaces (${name}).`,
    );
});

test("both failures are reported together", () => {
  expect(
    helperSandboxFailure(
      { name: "paws-runner", uid: 984 },
      host([manager], { "/proc/sys/user/max_user_namespaces": "0" }),
    ),
  ).toBe(
    "Sandboxed helper turns cannot start: paws-runner has no running systemd user manager; run sudo loginctl enable-linger paws-runner. The kernel refuses unprivileged user namespaces (user.max_user_namespaces=0).",
  );
});

test("this host's real files are readable", () => {
  const result = helperSandboxFailure({ name: "probe", uid: process.getuid?.() ?? 0 });
  expect(result === null || result.startsWith("Sandboxed helper turns cannot start:")).toBe(true);
});
