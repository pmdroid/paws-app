import { expect, test } from "bun:test";
import {
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
import { runProviderLogin } from "../src/runner-login-worker";
import type { RunnerLoginUpdate } from "../src/runner-protocol";

test("Codex device authorization survives immediate provider exit after accepted sign-in", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-device-login-"));
  const updates: RunnerLoginUpdate[] = [];
  let accepted = false;
  let verified = false;
  try {
    const path = join(home, "provider.js");
    writeFileSync(
      path,
      `
const input = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let authentication;
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "chat-gpt-device-code", name: "ChatGPT" }] } });
  else if (request.method === "authenticate") {
    authentication = request.id;
    send({ id: "authorization", method: "elicitation/create", params: { mode: "url", url: "https://auth.openai.com/codex/device", message: "Enter 1234", elicitationId: "code", requestId: authentication } });
  } else if (request.id === "authorization" && request.result?.action === "accept") { require("node:fs").writeFileSync(process.env.CODEX_HOME + "/auth.json", "{}"); send({ id: authentication, result: {} }); process.exit(0); }
});
`,
    );
    await runProviderLogin({
      agent: "codex",
      home,
      signal: AbortSignal.timeout(5000),
      command: [process.execPath, path],
      emit: (update) => updates.push(update),
      async answer(id) {
        expect(updates.at(-1)!.inputId).toBe(id);
        expect(updates.at(-1)!.authorization!.url).toBe("https://auth.openai.com/codex/device");
        expect(verified).toBe(false);
        accepted = true;
        return { answer: JSON.stringify({ accept: true }) };
      },
      async loginCommand(command, args, env) {
        expect(accepted).toBe(true);
        expect(command).toBe("codex");
        expect(args).toEqual(["login", "status"]);
        expect(env.HOME).not.toBe(home);
        expect(env.HOME!.startsWith(join(home, ".paws-login-"))).toBe(true);
        expect(env.CODEX_HOME).toBe(join(env.HOME!, ".codex"));
        expect(env.OPENAI_API_KEY).toBeUndefined();
        verified = true;
        return { exitCode: 0, stdout: "Logged in", stderr: "" };
      },
    });
    expect(verified).toBe(true);
    expect(readFileSync(join(home, ".codex", "auth.json"), "utf8")).toBe("{}");
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
    expect(updates.at(-1)).toEqual({
      state: "connected",
      terminal: "",
      authorization: null,
      inputId: null,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);

test("Claude receives terminal input and clears output after confirmed sign-in", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-terminal-login-"));
  const updates: RunnerLoginUpdate[] = [];
  try {
    const path = join(home, "provider.js");
    writeFileSync(
      path,
      `process.stdout.write("Paste provider code: "); process.stdin.once("data", () => { require("node:fs").writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/.credentials.json", "{}"); process.exit(0); });`,
    );
    let input = false;
    await runProviderLogin({
      agent: "claude",
      home,
      signal: AbortSignal.timeout(5000),
      command: [process.execPath, path],
      emit: (update) => updates.push(update),
      async answer(_id, signal) {
        if (!input) {
          input = true;
          return { answer: JSON.stringify({ text: "synthetic-code\r" }) };
        }
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
      async loginCommand(command, args, env) {
        expect(command).toBe("claude");
        expect(args).toEqual(["auth", "status"]);
        expect(env.CLAUDE_CONFIG_DIR).toBe(join(env.HOME!, ".claude"));
        return { exitCode: 0, stdout: JSON.stringify({ authMethod: "claude.ai" }), stderr: "" };
      },
    });
    expect(input).toBe(true);
    expect(updates.at(-1)!.state).toBe("connected");
    expect(updates.at(-1)!.terminal).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);

test("aborting an interactive provider kills its process and never reports connected", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-cancel-login-"));
  const updates: RunnerLoginUpdate[] = [];
  try {
    await runProviderLogin({
      agent: "claude",
      home,
      signal: AbortSignal.timeout(100),
      command: [process.execPath, "-e", "setInterval(() => {},1000)"],
      emit: (update) => updates.push(update),
      answer: (_id, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
      async loginCommand() {
        throw new Error("Cancelled logins must not probe");
      },
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
    mkdirSync(join(home, ".codex"));
    const live = join(home, ".codex", "auth.json");
    writeFileSync(live, old);
    const before = statSync(live).ino;
    const path = join(home, "provider.js");
    // The provider writes its credentials slowly, a piece at a time, as a real CLI may.
    writeFileSync(
      path,
      `
const fs = require("node:fs");
const next = ${JSON.stringify(next)};
const input = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
input.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "chat-gpt-device-code", name: "ChatGPT" }] } });
  else if (request.method === "authenticate") {
    const file = process.env.CODEX_HOME + "/auth.json";
    for (let at = 0; at < next.length; at += 8192) {
      fs.appendFileSync(file, next.slice(at, at + 8192));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    send({ id: request.id, result: {} });
  }
});
`,
    );
    const seen = new Set<string>();
    const reader = setInterval(() => {
      const value = readFileSync(live, "utf8");
      seen.add(value === old ? "old" : value === next ? "new" : "partial");
    }, 1);
    try {
      await runProviderLogin({
        agent: "codex",
        home,
        signal: AbortSignal.timeout(5000),
        command: [process.execPath, path],
        emit: (update) => updates.push(update),
        async answer() {
          throw new Error("This provider asks for no input");
        },
        async loginCommand(_command, _args, env) {
          expect(readFileSync(join(env.CODEX_HOME!, "auth.json"), "utf8")).toBe(next);
          expect(readFileSync(live, "utf8")).toBe(old);
          return { exitCode: 0, stdout: "Logged in", stderr: "" };
        },
      });
    } finally {
      clearInterval(reader);
    }
    seen.add(readFileSync(live, "utf8") === next ? "new" : "partial");
    expect(updates.at(-1)!.state).toBe("connected");
    expect([...seen].sort()).toEqual(["new", "old"]);
    expect(statSync(live).ino).not.toBe(before);
    expect(statSync(live).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, ".codex"))).toEqual(["auth.json"]);
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);

test("a Claude sign-in keeps the live settings and moves only the account over", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-claude-switch-"));
  try {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":"old"}');
    writeFileSync(
      join(home, ".claude", ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "old" } }),
    );
    const path = join(home, "provider.js");
    writeFileSync(
      path,
      `const fs = require("node:fs"); const dir = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(dir + "/.credentials.json", '{"claudeAiOauth":"new"}');
fs.writeFileSync(dir + "/.claude.json", JSON.stringify({ firstStartTime: "now", oauthAccount: { emailAddress: "new" } }));
process.exit(0);`,
    );
    const updates: RunnerLoginUpdate[] = [];
    await runProviderLogin({
      agent: "claude",
      home,
      signal: AbortSignal.timeout(5000),
      command: [process.execPath, path],
      emit: (update) => updates.push(update),
      answer: (_id, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
      async loginCommand() {
        return { exitCode: 0, stdout: JSON.stringify({ authMethod: "claude.ai" }), stderr: "" };
      },
    });
    expect(updates.at(-1)!.state).toBe("connected");
    expect(readFileSync(join(home, ".claude", ".credentials.json"), "utf8")).toBe(
      '{"claudeAiOauth":"new"}',
    );
    expect(JSON.parse(readFileSync(join(home, ".claude", ".claude.json"), "utf8"))).toEqual({
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: "new" },
    });
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
      `const fs = require("node:fs"); const path = process.env.HOME + "/.local/share/opencode/opencode.db"; if (fs.readFileSync(path, "utf8") !== "existing sessions") process.exit(1); process.stdout.write("Choose provider: "); process.stdin.once("data", () => { fs.appendFileSync(path, " and credentials"); process.exit(0); });`,
    );
    let answered = false;
    await runProviderLogin({
      agent: "opencode",
      home,
      command: [process.execPath, script],
      signal: AbortSignal.timeout(5000),
      emit: (update) => updates.push(update),
      answer: async (_id, signal) => {
        if (!answered) {
          answered = true;
          return { answer: JSON.stringify({ text: "provider\r" }) };
        }
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    expect(updates.at(-1)?.state).toBe("connected");
    expect(readFileSync(database, "utf8")).toBe("existing sessions and credentials");
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
