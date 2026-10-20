import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  } else if (request.id === "authorization" && request.result?.action === "accept") { send({ id: authentication, result: {} }); process.exit(0); }
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
        expect(env.HOME).toBe(home);
        expect(env.CODEX_HOME).toBe(join(home, ".codex"));
        expect(env.OPENAI_API_KEY).toBeUndefined();
        verified = true;
        return { exitCode: 0, stdout: "Logged in", stderr: "" };
      },
    });
    expect(verified).toBe(true);
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
      `process.stdout.write("Paste provider code: "); process.stdin.once("data", () => process.exit(0));`,
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
        expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude"));
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
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
