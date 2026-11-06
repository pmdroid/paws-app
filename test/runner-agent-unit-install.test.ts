import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

async function releaseTests(name: string) {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      new URL("local/linux-release-test.py", import.meta.url).pathname,
      new URL("../deploy/linux/release.py", import.meta.url).pathname,
      name,
    ],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout + stderr).not.toContain("skipped");
  expect(code).toBe(0);
  return stderr;
}

test("the installer ships the agent unit, its polkit rule and its environment directory", async () => {
  expect(await releaseTests("AgentUnit")).toMatch(/Ran 3 tests[\s\S]*\nOK\n?$/);
});

test("an install names paws-agent only where the host config has no agent user", async () => {
  expect(await releaseTests("AgentUserDefault")).toMatch(/Ran 4 tests[\s\S]*\nOK\n?$/);
});

test("the polkit rule lets paws-runner start and stop agent units and nothing else", () => {
  const rules: ((
    action: { id: string; lookup(name: string): string | undefined },
    subject: { user: string },
  ) => unknown)[] = [];
  const polkit = {
    Result: { YES: "yes" },
    addRule: (rule: (typeof rules)[number]) => rules.push(rule),
  };
  new Function(
    "polkit",
    readFileSync(new URL("../deploy/linux/paws-runner.polkit", import.meta.url), "utf8"),
  )(polkit);
  const decide = (
    user: string,
    verb: string,
    unit: string,
    id = "org.freedesktop.systemd1.manage-units",
  ) => rules[0]!({ id, lookup: (name) => ({ verb, unit })[name] }, { user });
  const execution = "paws-agent@01K00000000000000000000000.service";
  expect(decide("paws-runner", "start", execution)).toBe("yes");
  expect(decide("paws-runner", "stop", execution)).toBe("yes");
  expect(decide("paws-runner", "restart", execution)).toBeUndefined();
  expect(decide("paws-runner", "start", "paws-runner.service")).toBeUndefined();
  expect(decide("paws-runner", "start", "paws-agent@x.service")).toBeUndefined();
  expect(decide("paws-runner", "start", "paws-docker.service")).toBeUndefined();
  expect(decide("paws-agent", "start", execution)).toBeUndefined();
  expect(
    decide("paws-runner", "start", execution, "org.freedesktop.systemd1.manage-unit-files"),
  ).toBeUndefined();
});
