import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("issue VM network rules deny private destinations, follow host changes and ship with the runner", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      new URL("local/issue-vm-network-test.py", import.meta.url).pathname,
      new URL("../deploy/linux", import.meta.url).pathname,
    ],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout + stderr).not.toContain("skipped");
  expect(stderr).toMatch(/Ran 9 tests[\s\S]*\nOK\n?$/);
  expect(code).toBe(0);
});

test("the polkit rule lets paws-runner start and stop issue VM network units for slots 1 to 254 only", () => {
  const rules: ((
    action: { id: string; lookup(name: string): string | undefined },
    subject: { user: string },
  ) => unknown)[] = [];
  new Function(
    "polkit",
    readFileSync(new URL("../deploy/linux/paws-runner.polkit", import.meta.url), "utf8"),
  )({ Result: { YES: "yes" }, addRule: (rule: (typeof rules)[number]) => rules.push(rule) });
  const decide = (user: string, verb: string, unit: string) =>
    rules[0]!(
      { id: "org.freedesktop.systemd1.manage-units", lookup: (name) => ({ verb, unit })[name] },
      { user },
    );
  for (const slot of ["1", "9", "10", "99", "100", "199", "249", "254"]) {
    expect(decide("paws-runner", "start", `paws-issue-vm-network@${slot}.service`)).toBe("yes");
    expect(decide("paws-runner", "stop", `paws-issue-vm-network@${slot}.service`)).toBe("yes");
  }
  for (const slot of ["0", "01", "255", "300", "1a", "", "1.service x"])
    expect(decide("paws-runner", "start", `paws-issue-vm-network@${slot}.service`)).toBeUndefined();
  expect(decide("paws-runner", "restart", "paws-issue-vm-network@1.service")).toBeUndefined();
  expect(decide("paws-runner", "start", "paws-issue-vm-network.service")).toBeUndefined();
  expect(decide("paws-agent", "start", "paws-issue-vm-network@1.service")).toBeUndefined();
});
