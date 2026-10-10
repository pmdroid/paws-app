import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTokenStore, githubOAuthPath, FILE_TOKEN_STORE_DOCTOR_WARNING } from "../src/auth";
import type { CommandRunner, StoredGitHubOAuth } from "../src/auth/store";

const homes: string[] = [];
const token: StoredGitHubOAuth = {
  accessToken: "gho_injected_store_token",
  refreshToken: "ghr_injected_refresh",
  expiresAtMs: 123456,
  scope: "repo read:org",
  login: "octocat",
  id: 7,
  invalid: false,
};
const unavailable = {
  code: 1,
  stdout: "",
  stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY",
};

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "paws-store-fallback-"));
  homes.push(path);
  return path;
}

function storeAt(path: string, run: CommandRunner, installed = true) {
  return createTokenStore({
    home: path,
    platform: "linux",
    which: (bin) => (installed && bin === "secret-tool" ? "/injected/secret-tool" : null),
    run,
  });
}

function keyring(initial = "") {
  let payload = initial;
  const calls: string[] = [];
  const run: CommandRunner = async (_command, args, input) => {
    calls.push(args[0]!);
    if (args[0] === "store") payload = input!;
    if (args[0] === "clear") payload = "";
    if (args[0] === "lookup") {
      return { code: payload ? 0 : 1, stdout: payload, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, payload: () => payload };
}

function expectPrivateFile(path: string) {
  expect(statSync(githubOAuthPath(path)).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(githubOAuthPath(path))).mode & 0o777).toBe(0o700);
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("operational token storage", () => {
  test("a working Secret Service stays in the keyring", async () => {
    const path = home();
    const tool = keyring();
    const store = storeAt(path, tool.run);
    await store.save(token);
    expect(await store.load()).toEqual(token);
    expect(store.backend).toBe("secret-tool");
    expect(store.warning).toBeNull();
    expect(existsSync(githubOAuthPath(path))).toBe(false);
    await store.markInvalid();
    expect((await store.load())?.invalid).toBe(true);
    await store.delete();
    expect(await store.load()).toBeNull();
  });

  test("a missing binary round-trips through a private file without commands", async () => {
    const path = home();
    const store = storeAt(
      path,
      async () => {
        throw new Error("unexpected command");
      },
      false,
    );
    await store.save(token);
    expect(await store.load()).toEqual(token);
    expect(store.backend).toBe("file");
    expect(store.warning).toBe(FILE_TOKEN_STORE_DOCTOR_WARNING);
    expectPrivateFile(path);
  });

  test.each([
    unavailable.stderr,
    "secret-tool: The name org.freedesktop.secrets was not provided by any .service files",
    "secret-tool: Could not connect: No such file or directory",
    "secret-tool: Error calling StartServiceByName for org.freedesktop.secrets: Process org.freedesktop.secrets exited with status 1",
    "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY",
    "secret-tool: Unable to autolaunch a dbus-daemon without a $DISPLAY for X11",
  ])("an unavailable daemon saves and reloads a private fallback: %s", async (stderr) => {
    const path = home();
    const run: CommandRunner = async () => ({ ...unavailable, stderr });
    const store = storeAt(path, run);
    await store.save(token);
    expect(await store.load()).toEqual(token);
    expect(store.backend).toBe("file");
    expect(store.warning).toBe(FILE_TOKEN_STORE_DOCTOR_WARNING);
    expectPrivateFile(path);
    const restarted = storeAt(path, run);
    expect(restarted.backend).toBe("file");
    expect(restarted.warning).toBe(FILE_TOKEN_STORE_DOCTOR_WARNING);
    expect(await restarted.load()).toEqual(token);
    await restarted.markInvalid();
    expect((await restarted.load())?.invalid).toBe(true);
  });

  test("a disappeared executable can safely fall back", async () => {
    const path = home();
    const store = storeAt(path, async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await store.save(token);
    expect(await store.load()).toEqual(token);
    expect(store.backend).toBe("file");
    expectPrivateFile(path);
  });

  test("daemon read failures are actionable rather than signed-out results", async () => {
    const path = home();
    const store = storeAt(path, async () => unavailable);
    await expect(store.load()).rejects.toThrow(/Secret Service.*unavailable/);
    expect(existsSync(githubOAuthPath(path))).toBe(false);
  });

  test.each([
    "secret-tool: Permission denied",
    "secret-tool: org.freedesktop.DBus.Error.AccessDenied: rejected",
    "secret-tool: org.freedesktop.Secret.Error.IsLocked: collection is locked",
    "secret-tool: The operation was cancelled",
    "secret-tool: Authentication failed",
    "secret-tool: unknown failure",
    "",
  ])("write errors do not downgrade security or overwrite a keyring: %s", async (stderr) => {
    const path = home();
    const store = storeAt(path, async () => ({ code: 1, stdout: "", stderr }));
    await expect(store.save(token)).rejects.toThrow(/Could not save/);
    expect(store.backend).toBe("secret-tool");
    expect(existsSync(githubOAuthPath(path))).toBe(false);
  });

  test.each([
    "Permission denied",
    "Authentication failed",
    "collection is locked",
    "unknown failure",
  ])("read errors are not confused with a missing token: %s", async (stderr) => {
    const store = storeAt(home(), async () => ({ code: 1, stdout: "", stderr }));
    await expect(store.load()).rejects.toThrow(/Could not load/);
    expect(store.backend).toBe("secret-tool");
  });

  test("a refused spawn does not downgrade security", async () => {
    const path = home();
    const store = storeAt(path, async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(store.save(token)).rejects.toThrow();
    expect(store.backend).toBe("secret-tool");
    expect(existsSync(githubOAuthPath(path))).toBe(false);
  });

  test("an empty keyring is not an unavailable daemon", async () => {
    const tool = keyring();
    const store = storeAt(home(), tool.run);
    expect(await store.load()).toBeNull();
    expect(store.backend).toBe("secret-tool");
  });

  test("a recovered daemon cannot shadow the newer fallback with a stale keyring token", async () => {
    const path = home();
    const old = { ...token, accessToken: "gho_stale_keyring" };
    const tool = keyring(JSON.stringify(old));
    const fallback = storeAt(path, async () => unavailable);
    await fallback.save(token);
    const recovered = storeAt(path, tool.run);
    expect(recovered.backend).toBe("file");
    expect(await recovered.load()).toEqual(token);
    expect(tool.calls).toEqual([]);
    expect(JSON.parse(tool.payload())).toEqual(old);
    await recovered.delete();
    expect(tool.payload()).toBe("");
    expect(existsSync(githubOAuthPath(path))).toBe(false);
    expect(await storeAt(path, tool.run).load()).toBeNull();
  });

  test("failed keyring deletion retains the file and reports recovery instead of false logout", async () => {
    const path = home();
    const tool = keyring(JSON.stringify(token));
    const store = storeAt(path, async (command, args, input) =>
      args[0] === "clear"
        ? { code: 1, stdout: "", stderr: "Permission denied" }
        : tool.run(command, args, input),
    );
    await expect(store.delete()).rejects.toThrow(/Could not delete/);
    expect(JSON.parse(tool.payload())).toEqual(token);
  });

  test("logout during daemon outage reports the failure and preserves recovery", async () => {
    const path = home();
    const store = storeAt(path, async () => unavailable);
    await store.save(token);
    await expect(store.delete()).rejects.toThrow(/Secret Service.*unavailable/);
    expect(await store.load()).toEqual(token);
    expectPrivateFile(path);
  });
});
