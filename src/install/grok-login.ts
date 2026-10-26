import { journalCaught } from "../journal";
import {
  GROK_AGENT_ARGS,
  GROK_LOGIN_MESSAGE,
  checkOwnLogin,
  rejectAutoApprove,
  resolveGrokCommand,
  selectGrokAuthMethod,
  xaiApiKeyPresent,
  type GrokCommand,
} from "../acp";
import { loadConfigFile, pawsPaths, type AgentsConfig, type EnvSource } from "../config";

export type GrokLoginStatus = {
  installed: boolean;
  loggedIn: boolean;
  authMethods: string[];
  /** Method id when logged in, otherwise one actionable line. */
  detail: string;
  args: string[];
};

export type GrokLoginOptions = {
  env?: EnvSource;
  agents?: AgentsConfig;
  packageRoot?: string;
  timeoutMs?: number;
  /** Test stand-in for the grok executable. */
  command?: string;
  args?: string[];
};

/**
 * Spawn `grok agent stdio`, read `initialize` / `authMethods`, and close.
 * Does not send a prompt and does not read `~/.grok/auth.json`.
 */
export async function grokLoginStatus(options: GrokLoginOptions = {}): Promise<GrokLoginStatus> {
  const env = options.env ?? process.env;
  const agents = options.agents ?? loadAgents(env);
  const resolved = options.command
    ? commandOverride(options.command, options.args)
    : resolveGrokCommand(agents, options.packageRoot);
  if (resolved.error) {
    return {
      installed: false,
      loggedIn: false,
      authMethods: [],
      detail: resolved.error,
      args: resolved.args,
    };
  }
  rejectAutoApprove(resolved.args);
  const allowApiKey = agents.grok.allowApiKey;
  try {
    const auth = await checkOwnLogin({
      role: "implementer",
      command: resolved.command,
      args: resolved.args,
      env,
      timeoutMs: options.timeoutMs ?? 15_000,
      allowXaiApiKey: allowApiKey,
    });
    const authMethods = auth.authMethods.map((method) => method.id);
    const methodId = selectGrokAuthMethod(auth.authMethods, {
      apiKeyPresent: xaiApiKeyPresent(env),
      allowApiKey,
    });
    if (methodId === null) {
      return {
        installed: true,
        loggedIn: false,
        authMethods,
        detail: GROK_LOGIN_MESSAGE,
        args: resolved.args,
      };
    }
    return {
      installed: true,
      loggedIn: true,
      authMethods,
      detail: methodId,
      args: resolved.args,
    };
  } catch (error) {
    journalCaught(error, "grok-login.grokLoginStatus.checkOwnLogin", null);
    const message = error instanceof Error ? error.message : String(error);
    const line = message.split("\n").find((item) => item.trim().length > 0) ?? message;
    return {
      installed: true,
      loggedIn: false,
      authMethods: [],
      detail: line,
      args: resolved.args,
    };
  }
}

function commandOverride(command: string, args: string[] | undefined): GrokCommand {
  return { command, args: args ?? [...GROK_AGENT_ARGS], error: null };
}

function loadAgents(env: EnvSource): AgentsConfig {
  const home = env.PAWS_HOME;
  if (home === undefined || home.length === 0) {
    return { implementer: "claude", grok: { path: null, allowApiKey: false } };
  }
  return loadConfigFile(pawsPaths(home).configFile).agents;
}
