import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerLoginCommand, runProviderLogin } from "../src/runner-login-worker";
import type { RunnerLoginUpdate } from "../src/runner-protocol";

test("a Claude login on the runner is refused and spawns nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-claude-refused-"));
  const updates: RunnerLoginUpdate[] = [];
  const marker = join(home, "spawned");
  try {
    await runProviderLogin({
      agent: "claude",
      home,
      signal: AbortSignal.timeout(5000),
      command: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
      ],
      emit: (update) => updates.push(update),
      async answer() {
        throw new Error("A refused login asks for no input");
      },
      account: {
        publish() {
          throw new Error("A refused login must not publish");
        },
      },
    });
    expect(updates.map((update) => update.state)).toEqual(["failed"]);
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("aborting an interactive provider kills its process and never reports connected", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-cancel-login-"));
  const updates: RunnerLoginUpdate[] = [];
  try {
    await runProviderLogin({
      agent: "opencode",
      home,
      signal: AbortSignal.timeout(100),
      command: [process.execPath, "-e", "setInterval(() => {},1000)"],
      emit: (update) => updates.push(update),
      answer: (_id, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    });
    expect(updates.at(-1)!.state).toBe("failed");
    expect(updates.some((update) => update.state === "connected")).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);

for (const outcome of ["success", "failure", "cancel"] as const) {
  test(`Grok device login handles ${outcome} without exposing provider output`, async () => {
    const home = mkdtempSync(join(tmpdir(), "paws-grok-device-"));
    const updates: RunnerLoginUpdate[] = [];
    try {
      const path = join(home, "provider.js");
      writeFileSync(
        path,
        `
process.stderr.write(${JSON.stringify("\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\n\nConfirm this code in your browser:\n\n  ABCD-1234\n\n\u001b[90mOnly continue with a code you requested. Don't share it with anyone.\u001b[0m\n\nWaiting for authorization...\n")});
process.stdout.write("synthetic-private-token");
require("node:fs").writeFileSync(process.env.HOME + "/.grok/auth.json", "{}");
${outcome === "cancel" ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(${outcome === "success" ? 0 : 1}), 100);`}
`,
      );
      await runProviderLogin({
        agent: "grok",
        home,
        command: [process.execPath, path],
        signal: AbortSignal.timeout(outcome === "cancel" ? 500 : 5000),
        emit: (update) => updates.push(update),
        async answer() {
          throw new Error("Grok polls the provider without browser input");
        },
      });
      expect(
        updates.some(
          (update) =>
            update.authorization?.url === "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
        ),
      ).toBe(true);
      expect(updates.find((update) => update.authorization)?.authorization?.message).toContain(
        "ABCD-1234",
      );
      expect(JSON.stringify(updates)).not.toContain("synthetic-private-token");
      expect(updates.at(-1)!.state).toBe(outcome === "success" ? "connected" : "failed");
      expect(updates.at(-1)!.authorization).toBeNull();
      expect(statSync(join(home, ".grok", "auth.json"), { throwIfNoEntry: false })?.isFile()).toBe(
        outcome === "success" ? true : undefined,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("a sign-in renames new credentials over the ones running turns read", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-switch-login-"));
  const updates: RunnerLoginUpdate[] = [];
  const old = JSON.stringify({ account: "old", padding: "o".repeat(65536) });
  const next = JSON.stringify({ account: "new", padding: "n".repeat(65536) });
  try {
    mkdirSync(join(home, ".grok"));
    const live = join(home, ".grok", "auth.json");
    writeFileSync(live, old, { mode: 0o660 });
    chmodSync(live, 0o660);
    const before = statSync(live).ino;
    const path = join(home, "provider.js");
    writeFileSync(
      path,
      `
const fs = require("node:fs");
const next = ${JSON.stringify(next)};
const file = process.env.HOME + "/.grok/auth.json";
(async () => {
  for (let at = 0; at < next.length; at += 8192) {
    fs.appendFileSync(file, next.slice(at, at + 8192));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (fs.readFileSync(${JSON.stringify(live)}, "utf8") !== ${JSON.stringify(old)}) process.exit(1);
  process.exit(0);
})();
`,
    );
    const seen = new Set<string>();
    const reader = setInterval(() => {
      const value = readFileSync(live, "utf8");
      seen.add(value === old ? "old" : value === next ? "new" : "partial");
    }, 1);
    try {
      await runProviderLogin({
        agent: "grok",
        home,
        signal: AbortSignal.timeout(5000),
        command: [process.execPath, path],
        emit: (update) => updates.push(update),
        async answer() {
          throw new Error("Grok polls the provider without browser input");
        },
      });
    } finally {
      clearInterval(reader);
    }
    seen.add(readFileSync(live, "utf8") === next ? "new" : "partial");
    expect(updates.at(-1)!.state).toBe("connected");
    expect([...seen].sort()).toEqual(["new", "old"]);
    expect(statSync(live).ino).not.toBe(before);
    expect(statSync(live).mode & 0o777).toBe(0o660);
    expect(readdirSync(join(home, ".grok"))).toEqual(["auth.json"]);
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);

test("a sign-in that writes no credentials fails and leaves the live ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-empty-login-"));
  try {
    mkdirSync(join(home, ".grok"));
    writeFileSync(join(home, ".grok", "auth.json"), "old");
    const updates: RunnerLoginUpdate[] = [];
    await runProviderLogin({
      agent: "grok",
      home,
      signal: AbortSignal.timeout(5000),
      command: [process.execPath, "-e", "process.exit(0)"],
      emit: (update) => updates.push(update),
      async answer() {
        throw new Error("Grok polls the provider without browser input");
      },
    });
    expect(updates.at(-1)!.state).toBe("failed");
    expect(readFileSync(join(home, ".grok", "auth.json"), "utf8")).toBe("old");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);

test("OpenCode signs in with its device code, no provider or method picker", () => {
  expect(providerLoginCommand("opencode").slice(1)).toEqual([
    "auth",
    "login",
    "--standalone",
    "--method",
    "device",
    "opencode",
  ]);
});

test("OpenCode signs in against its live SQLite home without replacing session data", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-opencode-login-"));
  const updates: RunnerLoginUpdate[] = [];
  try {
    const directory = join(home, ".local", "share", "opencode");
    mkdirSync(directory, { recursive: true });
    const database = join(directory, "opencode.db");
    writeFileSync(database, "existing sessions");
    const script = join(home, "login.js");
    writeFileSync(
      script,
      `const fs = require("node:fs"); const path = process.env.HOME + "/.local/share/opencode/opencode.db"; if (fs.readFileSync(path, "utf8") !== "existing sessions") process.exit(1); process.stdout.write("Enter code: FRKN-JFBS\\nhttps://opencode.ai/console/device?user_code=FRKN-JFBS\\n"); setTimeout(() => { fs.appendFileSync(path, " and credentials"); process.exit(0); }, 200);`,
    );
    await runProviderLogin({
      agent: "opencode",
      home,
      command: [process.execPath, script],
      signal: AbortSignal.timeout(5000),
      emit: (update) => updates.push(update),
      answer: (_id, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    });
    expect(updates.some((update) => update.terminal.includes("Enter code: FRKN-JFBS"))).toBe(true);
    expect(updates.at(-1)?.state).toBe("connected");
    expect(readFileSync(database, "utf8")).toBe("existing sessions and credentials");
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
