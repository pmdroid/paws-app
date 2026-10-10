import { mock } from "bun:test";
import type { GitHubTokenStore } from "../../src/auth";
import * as device from "../../src/auth/github-device";
import * as storage from "../../src/auth/store";

function record(event: string, value?: unknown): void {
  process.stderr.write(`${JSON.stringify({ event, value })}\n`);
}

const log = console.log;
console.log = (...args: unknown[]) => {
  record("output", args.join(" "));
  log(...args);
};

const pollDeviceToken = device.pollDeviceToken;

const store: GitHubTokenStore = {
  backend: "file",
  warning: null,
  load: async () => null,
  save: async (value) => {
    record("save", value.login);
  },
  markInvalid: async () => {},
  delete: async () => {},
};
mock.module("../../src/auth/store", () => ({ ...storage, createTokenStore: () => store }));
mock.module("../../src/auth/github-device", () => ({
  ...device,
  openVerificationPage: async (url: string) => {
    record("browser", url);
    if (process.env.PAWS_TEST_BROWSER === "failed") throw new Error("No browser available");
  },
  pollDeviceToken: (input: Parameters<typeof device.pollDeviceToken>[0]) =>
    pollDeviceToken({
      ...input,
      sleep: async () => {
        record("poll-sleep");
      },
    }),
}));

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  record("fetch", url);
  if (url === "https://github.com/login/device/code") {
    return Response.json({
      device_code: "fixture-device",
      user_code: "LOCAL-CODE",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 900,
    });
  }
  if (url === "https://github.com/login/oauth/access_token") {
    return Response.json({ access_token: "fixture-access", scope: "repo read:org" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json(
      { login: "local-user", id: 7 },
      { headers: { "x-oauth-scopes": "repo, read:org" } },
    );
  }
  throw new Error(`Unexpected network request: ${url}`);
}) as typeof fetch;
