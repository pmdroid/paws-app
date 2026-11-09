import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach } from "bun:test";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "paws-presets-"));
  homes.push(home);
  return home;
}
import { handleAgentSettingsRequest } from "./handler";

test("agents settings save and return presets and refuse duplicate names", async () => {
  const options = { configPath: join(tempHome(), "config.toml"), csrfToken: "test" };
  const settings = {
    defaults: {
      implementer: { agent: "claude", model: "opus" },
      reviewer: { agent: "codex", model: "review" },
    },
    projects: [{ repo: "acme/app" }],
    presets: {
      Opus: { agent: "claude", model: "opus" },
      Codex: { agent: "codex", model: "codex" },
    },
  };
  const request = (body?: unknown) =>
    new Request("http://localhost/api/settings/agents", {
      method: body ? "PUT" : "GET",
      headers: { "content-type": "application/json", "x-paws-csrf": "test" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await handleAgentSettingsRequest(request(settings), options))?.status).toBe(200);
  expect(await (await handleAgentSettingsRequest(request(), options))!.json()).toMatchObject(
    settings,
  );
  expect(
    (
      await handleAgentSettingsRequest(
        request({ ...settings, presets: { ...settings.presets, opus: settings.presets.Opus } }),
        options,
      )
    )?.status,
  ).toBe(400);
});
