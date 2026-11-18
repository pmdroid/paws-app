export const SLACK_CALLBACK_PATH = "/oauth/slack/callback";
export const SLACK_EVENTS_PATH = "/webhooks/slack";

const CAPABILITIES = {
  threads: {
    scopes: ["app_mentions:read", "channels:history", "channels:read", "chat:write"],
    events: ["app_mention", "message.channels"],
  },
  directMessages: {
    scopes: ["im:history", "im:write", "chat:write"],
    events: ["message.im"],
  },
  agent: {
    scopes: ["assistant:write"],
    events: ["assistant_thread_started", "assistant_thread_context_changed"],
  },
  members: { scopes: ["users:read", "users:read.email"], events: [] },
} as const;
type Capability = keyof typeof CAPABILITIES;

const LIFECYCLE_EVENTS = ["app_uninstalled", "tokens_revoked"];

export const SLACK_INSTALL_SCOPES = [
  ...new Set(Object.values(CAPABILITIES).flatMap((capability) => capability.scopes)),
];

export const SLACK_CODE_UNAVAILABLE =
  "Slack Code is not available on this connection yet. Ordinary threads and app messages work without it; a later Paws release adds it to this same connection with a reconnect.";

export function slackScopes(scope: string): string[] {
  return [...new Set(scope.split(/[ ,]+/).filter(Boolean))].sort();
}

export function slackCapabilities(scope: string) {
  const granted = new Set(slackScopes(scope));
  const missing = SLACK_INSTALL_SCOPES.filter((name) => !granted.has(name));
  const capability = (name: Capability) => {
    const absent = CAPABILITIES[name].scopes.filter((required) => !granted.has(required));
    return absent.length === 0
      ? { ready: true, missing: [] }
      : {
          ready: false,
          missing: absent,
          message: `Reconnect Slack to grant ${absent.join(", ")}.`,
        };
  };
  return {
    granted: [...granted],
    missing,
    threads: capability("threads"),
    directMessages: capability("directMessages"),
    agent: capability("agent"),
    members: capability("members"),
    code: { ready: false, message: SLACK_CODE_UNAVAILABLE },
  };
}

export function slackAppManifest(origin: string) {
  const base = new URL(origin).origin;
  return {
    display_information: { name: "Paws", description: "Plan and ship work with Paws." },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: "Paws", always_online: true },
      assistant_view: { assistant_description: "Ask Paws, plan work and follow it in Slack." },
    },
    oauth_config: {
      redirect_urls: [base + SLACK_CALLBACK_PATH],
      scopes: { bot: SLACK_INSTALL_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: base + SLACK_EVENTS_PATH,
        bot_events: [
          ...Object.values(CAPABILITIES).flatMap((capability) => capability.events),
          ...LIFECYCLE_EVENTS,
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}
