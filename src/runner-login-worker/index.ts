import { journalCaught } from "../journal";
import { runGrokLogin } from "./grok";
import { discardLoginHome, publishCredentials, stageLoginHome } from "./credentials";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { resolveAdapter, resolveOpencodeCommand, minimalAgentEnv } from "../acp";
import { checkDeveloperLogin, type LoginCommandRunner } from "../install";
import { RunnerLoginInputSchema, type RunnerLoginUpdate } from "../runner-protocol";

export async function runProviderLogin(options: {
  agent: "claude" | "codex" | "grok" | "opencode";
  home: string;
  signal: AbortSignal;
  emit(update: RunnerLoginUpdate): void;
  answer(id: string, signal: AbortSignal): Promise<{ answer: string }>;
  command?: string[];
  loginCommand?: LoginCommandRunner;
}) {
  options.signal.throwIfAborted();
  // Turns on this runner read the live home while the provider signs in to a staged one.
  let home: string | undefined;
  try {
    if (options.agent === "opencode") {
      await signIn(options);
    } else {
      home = stageLoginHome(options.home);
      await signIn({ ...options, home });
      options.signal.throwIfAborted();
      publishCredentials(options.agent, home, options.home);
    }
    options.signal.throwIfAborted();
    options.emit({ state: "connected", terminal: "", authorization: null, inputId: null });
  } catch (caughtError4) {
    journalCaught(caughtError4, "runner-login-worker.runProviderLogin", null);
    options.emit({ state: "failed", terminal: "", authorization: null, inputId: null });
  } finally {
    if (home) discardLoginHome(home);
  }
}

export function providerLoginCommand(agent: "claude" | "opencode") {
  return agent === "claude"
    ? ["/opt/paws-runner/bin/claude", "auth", "login"]
    : [
        resolveOpencodeCommand().command,
        "auth",
        "login",
        "--standalone",
        "--method",
        "device",
        "opencode",
      ];
}

async function signIn(options: Parameters<typeof runProviderLogin>[0]) {
  const env = minimalAgentEnv({
    HOME: options.home,
    PATH: "/opt/paws-runner/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    CODEX_HOME: `${options.home}/.codex`,
    CLAUDE_CONFIG_DIR: `${options.home}/.claude`,
  });
  const state: RunnerLoginUpdate = {
    state: "starting",
    terminal: "",
    authorization: null,
    inputId: null,
  };
  if (options.agent === "grok") {
    await runGrokLogin({ ...options, env });
  } else if (options.agent === "claude" || options.agent === "opencode") {
    state.state = "waiting";
    state.inputId = randomUUID();
    const decoder = new TextDecoder();
    let outputBytes = 0;
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 30,
      data(_terminal, bytes) {
        outputBytes += bytes.byteLength;
        if (outputBytes > 131072) {
          abort.abort();
          return;
        }
        state.terminal = (state.terminal + decoder.decode(bytes, { stream: true })).slice(-32768);
        options.emit({ ...state });
      },
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const kill = () => child?.kill("SIGKILL");
    signal.addEventListener("abort", kill, { once: true });
    try {
      child = Bun.spawn(options.command ?? providerLoginCommand(options.agent), {
        cwd: options.home,
        env: { ...env, NO_BROWSER: "1" },
        terminal,
      });
      options.emit({ ...state });
      const input = (async () => {
        while (!signal.aborted) {
          const answer = RunnerLoginInputSchema.parse(
            JSON.parse((await options.answer(state.inputId!, signal)).answer),
          );
          signal.throwIfAborted();
          if (!("text" in answer)) throw new Error("Terminal input is required");
          terminal.localFlags &= ~8;
          terminal.write(answer.text);
          state.inputId = randomUUID();
          options.emit({ ...state });
        }
      })();
      void input.catch((caughtError1) => {
        journalCaught(caughtError1, "runner-login-worker.runProviderLogin", null);
        return abort.abort();
      });
      const code = await child.exited;
      abort.abort();
      await input.catch((caughtError2) => {
        journalCaught(caughtError2, "runner-login-worker.runProviderLogin", null);
        return undefined;
      });
      options.signal.throwIfAborted();
      if (code !== 0) throw new Error("Provider login did not complete");
    } finally {
      signal.removeEventListener("abort", kill);
      abort.abort();
      child?.kill("SIGKILL");
      await child?.exited;
      terminal.close();
    }
  } else {
    const adapter = resolveAdapter("reviewer", env);
    const command = options.command ?? [adapter.command, ...adapter.args];
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.home,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (caughtError3) {
          journalCaught(
            caughtError3,
            "runner-login-worker.runProviderLogin.kill",
            null,
            "process may have exited",
          );
        }
      }
    };
    options.signal.addEventListener("abort", kill, { once: true });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const failed = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Provider login exited")));
    });
    const app = client({ name: "paws-login" }).onRequest(
      methods.client.elicitation.create,
      async ({ params: request }) => {
        if (request.mode !== "url" || typeof request.url !== "string")
          throw new Error("Provider must request a browser authorization");
        const url = new URL(request.url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "auth.openai.com" ||
          url.username ||
          url.password ||
          url.port
        )
          throw new Error("Unexpected provider authorization URL");
        state.state = "waiting";
        state.authorization = { url: request.url, message: request.message };
        state.inputId = randomUUID();
        options.emit({ ...state });
        const answer = RunnerLoginInputSchema.parse(
          JSON.parse((await options.answer(state.inputId, options.signal)).answer),
        );
        options.signal.throwIfAborted();
        if (!("accept" in answer)) throw new Error("Authorization confirmation is required");
        state.inputId = null;
        options.emit({ ...state });
        return { action: answer.accept ? "accept" : "decline" };
      },
    );
    try {
      await Promise.race([
        failed,
        app.connectWith(
          ndJsonStream(
            Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
          ),
          async (connection) => {
            const initialized = await connection.request(methods.agent.initialize, {
              protocolVersion: PROTOCOL_VERSION,
              clientCapabilities: { elicitation: { url: {} } },
              clientInfo: { name: "paws-login", version: "1" },
            });
            if (!initialized.authMethods?.some((method) => method.id === "chat-gpt-device-code"))
              throw new Error("Provider device login is unavailable");
            await connection.request(methods.agent.authenticate, {
              methodId: "chat-gpt-device-code",
            });
          },
        ),
      ]);
      options.signal.throwIfAborted();
    } finally {
      options.signal.removeEventListener("abort", kill);
      kill();
      await exited;
    }
  }
  if (options.agent !== "grok" && options.agent !== "opencode") {
    const checked = await checkDeveloperLogin({
      cli: options.agent,
      env,
      run: options.loginCommand,
    });
    if (!checked.loggedIn) throw new Error("Provider did not confirm sign-in");
  }
}
