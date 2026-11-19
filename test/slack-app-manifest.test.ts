import { expect, test } from "bun:test";
import { SLACK_INSTALL_SCOPES } from "../src/slack";

const manifest = Bun.YAML.parse(
  await Bun.file(new URL("../deploy/slack/manifest.yaml", import.meta.url)).text(),
) as {
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url: string };
  };
};

test("the Slack app manifest asks for exactly the scopes Paws installs with", () => {
  expect([...manifest.oauth_config.scopes.bot].sort()).toEqual([...SLACK_INSTALL_SCOPES].sort());
});

test("the Slack app manifest points Slack at the Paws callback and webhook", () => {
  expect(manifest.oauth_config.redirect_urls).toEqual([
    "https://paws.example.com/oauth/slack/callback",
  ]);
  expect(manifest.settings.event_subscriptions.request_url).toBe(
    "https://paws.example.com/webhooks/slack",
  );
  expect(manifest.settings.interactivity).toEqual({
    is_enabled: true,
    request_url: "https://paws.example.com/webhooks/slack",
  });
  expect(manifest.settings.event_subscriptions.bot_events).toContain("app_mention");
});
