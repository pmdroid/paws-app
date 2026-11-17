import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dashboardModeProblem, loadRuntime, pawsPaths } from "../src/config";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";

function home(config: string): string {
  const dir = tempHome();
  writeFileSync(pawsPaths(dir).configFile, config, { mode: 0o600 });
  return dir;
}

const DASHBOARD = '[tracker]\nkind = "dashboard"\n';

const complete = (dir: string) => ({
  PAWS_HOME: dir,
  PAWS_PUBLIC_DASHBOARD: "1",
  PAWS_PUBLIC_URL: "https://paws.example.com",
  GITHUB_APP_ID: "1",
  PAWS_GITHUB_CLIENT_ID: "client",
  PAWS_GITHUB_CLIENT_SECRET: "secret",
  GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
  GITHUB_APP_INSTALLATION_ID: "12345",
});

function problem(source: Record<string, string | undefined>): string | null {
  return dashboardModeProblem(source, loadRuntime(source));
}

describe("dashboard tracker kind", () => {
  test("[tracker] kind dashboard loads as the dashboard tracker", () => {
    const runtime = loadRuntime({ PAWS_HOME: home(DASHBOARD) });
    expect(runtime.configError).toBeNull();
    expect(runtime.trackerKind).toBe("dashboard");
  });

  test("[tracker] kind linear loads as linear", () => {
    expect(loadRuntime({ PAWS_HOME: home('[tracker]\nkind = "linear"\n') }).trackerKind).toBe(
      "linear",
    );
  });

  test("an unknown tracker kind is a config error naming tracker.kind", () => {
    const runtime = loadRuntime({ PAWS_HOME: home('[tracker]\nkind = "jira"\n') });
    expect(runtime.configError).toContain("tracker.kind");
  });

  test("dashboardModeProblem is null in Linear mode and for a complete dashboard config", () => {
    expect(problem({ PAWS_HOME: home("") })).toBeNull();
    expect(problem(complete(home(DASHBOARD)))).toBeNull();
  });

  test("dashboardModeProblem names the public HTTPS dashboard", () => {
    const message = "Dashboard mode requires PAWS_PUBLIC_DASHBOARD=1 and an HTTPS PAWS_PUBLIC_URL.";
    const dir = home(DASHBOARD);
    expect(problem({ ...complete(dir), PAWS_PUBLIC_DASHBOARD: "0" })).toBe(message);
    expect(problem({ ...complete(dir), PAWS_PUBLIC_URL: "http://paws.example.com" })).toBe(message);
    expect(problem({ ...complete(dir), PAWS_PUBLIC_URL: undefined })).toBe(message);
  });

  test("dashboardModeProblem names the GitHub App credentials", () => {
    expect(problem({ ...complete(home(DASHBOARD)), GITHUB_APP_ID: undefined })).toBe(
      "Dashboard mode requires the GitHub App credentials (docs/github-app.md).",
    );
  });

  test("dashboardModeProblem names the installation id", () => {
    const message =
      "Dashboard mode requires GITHUB_APP_INSTALLATION_ID, the one installation this workspace belongs to.";
    const dir = home(DASHBOARD);
    expect(problem({ ...complete(dir), GITHUB_APP_INSTALLATION_ID: undefined })).toBe(message);
    expect(problem({ ...complete(dir), GITHUB_APP_INSTALLATION_ID: "0123" })).toBe(message);
    expect(problem({ ...complete(dir), GITHUB_APP_INSTALLATION_ID: "abc" })).toBe(message);
  });

  test("startPaws refuses a dashboard config before it opens the database", async () => {
    const dir = home(DASHBOARD);
    await expect(startPaws(complete(dir))).rejects.toThrow(
      "Dashboard mode is not available in this build.",
    );
    expect(existsSync(pawsPaths(dir).pgliteDir)).toBe(false);
  });
});
