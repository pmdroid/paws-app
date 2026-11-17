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
    const agent = options.agent;
    if (agent === "claude")
      throw new Error("Claude signs in with a pasted setup token on Paws, not on the runner");
    if (agent === "codex") throw new Error("Codex signs in through Paws, not on the runner");
    if (agent === "opencode" && !options.account) {
      await signIn({ ...options, agent });
    } else {
      const staged = stageLoginHome(options.home);
      home = staged;
      await signIn({ ...options, agent, home: staged });
      options.signal.throwIfAborted();
      const write = () => publishCredentials(agent, staged, options.home);
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

export function providerLoginCommand(agent: "opencode") {
  return [
    resolveOpencodeCommand().command,
    "auth",
    "login",
    "--standalone",
    "--method",
    "device",
    agent,
  ];
}

async function signIn(
  options: Omit<Parameters<typeof runProviderLogin>[0], "agent"> & { agent: "grok" | "opencode" },
) {
  const env = minimalAgentEnv({
    HOME: options.home,
    PATH: "/opt/paws-runner/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    CODEX_HOME: `${options.home}/.codex`,
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
  } else {
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
        state.terminal = rawOutput.slice(-32768);
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
  }
}
