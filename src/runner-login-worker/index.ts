import { writeFileSync } from "node:fs";
import { journalCaught } from "../journal";
import { runGrokLogin } from "./grok";
import { discardLoginHome, publishCredentials, stageLoginHome } from "./credentials";
import { randomUUID } from "node:crypto";
import { accountAgentEnv, resolveOpencodeCommand, minimalAgentEnv } from "../acp";
import { RunnerLoginInputSchema, type RunnerLoginUpdate } from "../runner-protocol";

export async function runProviderLogin(options: {
  agent: "claude" | "codex" | "grok" | "opencode";
  home: string;
  signal: AbortSignal;
  emit(update: RunnerLoginUpdate): void;
  answer(id: string, signal: AbortSignal): Promise<{ answer: string }>;
  command?: string[];
  account?: { publish(write: () => void): void };
}) {
  options.signal.throwIfAborted();
  // Turns on this runner read the live home while the provider signs in to a staged one.
  let home: string | undefined;
  try {
    if (options.agent === "opencode" && !options.account) {
      await signIn(options);
    } else {
      const staged = stageLoginHome(options.home);
      home = staged;
      await signIn({ ...options, home: staged });
      options.signal.throwIfAborted();
      const write = () => publishCredentials(options.agent, staged, options.home);
      if (options.account) options.account.publish(write);
      else write();
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
    ? ["/opt/paws-runner/bin/claude", "setup-token"]
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
    ...(options.account ? accountAgentEnv(options.home) : {}),
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
    let rawOutput = "";
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
        rawOutput += decoder.decode(bytes, { stream: true });
        let visible = rawOutput;
        if (options.agent === "claude") {
          const prefix = "sk-ant-oat01-";
          for (let length = 1; length < prefix.length; length++)
            if (visible.endsWith(prefix.slice(0, length))) {
              visible = visible.slice(0, -length);
              break;
            }
          visible = visible.replace(/sk-ant-oat01-[A-Za-z0-9_-]*/g, "[masked]");
        }
        state.terminal = visible.slice(-32768);
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
      if (options.agent === "claude") {
        const token = rawOutput.match(/sk-ant-oat01-[A-Za-z0-9_-]+/)?.[0];
        if (!token) throw new Error("Provider did not print an OAuth token");
        const createdAt = Date.now();
        writeFileSync(
          `${options.home}/.claude/paws-oauth.json`,
          JSON.stringify({
            kind: "oauth_token",
            token,
            createdAt,
            expiresAt: createdAt + 365 * 86400000,
          }),
          { mode: 0o600 },
        );
      }
    } finally {
      signal.removeEventListener("abort", kill);
      abort.abort();
      child?.kill("SIGKILL");
      await child?.exited;
      terminal.close();
    }
  } else {
    throw new Error("Codex signs in through Paws, not on the runner");
  }
}
