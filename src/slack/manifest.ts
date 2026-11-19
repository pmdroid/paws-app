import type { Q, Steps } from "../db";
import { installedSlackTokensSteps } from "./oauth";

export const SLACK_CALLBACK_PATH = "/oauth/slack/callback";

const CAPABILITIES = {
  threads: ["app_mentions:read", "channels:history", "channels:read", "chat:write"],
  directMessages: ["im:history", "im:write", "chat:write"],
  agent: ["assistant:write"],
  members: ["users:read", "users:read.email"],
};

export const SLACK_INSTALL_SCOPES = [...new Set(Object.values(CAPABILITIES).flat())];

export function slackCapabilities(scope: string) {
  const granted = [...new Set(scope.split(/[ ,]+/).filter(Boolean))].sort();
  const state = (scopes: string[]) => {
    const missing = scopes.filter((name) => !granted.includes(name));
    return missing.length === 0
      ? { ready: true, missing }
      : { ready: false, missing, message: `Reconnect Slack to grant ${missing.join(", ")}.` };
  };
  return {
    granted,
    missing: SLACK_INSTALL_SCOPES.filter((name) => !granted.includes(name)),
    ...(Object.fromEntries(
      Object.entries(CAPABILITIES).map(([name, scopes]) => [name, state(scopes)]),
    ) as Record<keyof typeof CAPABILITIES, ReturnType<typeof state>>),
    code: { ready: false, message: "Slack Code is not available on this connection yet." },
  };
}

export type SlackCapabilities = ReturnType<typeof slackCapabilities>;

export function* slackConnectionsSteps(
  q: Q,
  home: string,
): Steps<{ teamId: string; capabilities: SlackCapabilities }[]> {
  const tokens = yield* installedSlackTokensSteps(q, home);
  return tokens.map((token) => ({
    teamId: token.teamId,
    capabilities: slackCapabilities(token.scope),
  }));
}
