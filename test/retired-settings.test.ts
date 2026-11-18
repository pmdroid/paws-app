import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SETTINGS_KEY, readSetting, updateSetting } from "../src/db";
import { startPaws } from "../src/index";
import { setJournalSink } from "../src/journal";
import { handleAgentSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";
import { pgliteServer } from "./pglite";

const STORED = `[agents]
implementer = "codex"

[agents.grok]
path = "/usr/local/bin/grok"
allow_api_key = true
`;

const start = (home: string, url: string) =>
  startPaws({ PAWS_HOME: home, PAWS_PORT: "0", PAWS_HOST: "127.0.0.1", PAWS_DATABASE_URL: url });

const settingsRequest = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1:8787/api/settings/agents", {
    method,
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("stored settings with a retired section start Paws, which names it and removes it on request", async () => {
  const server = await pgliteServer();
  const home = tempHome();
  const messages: string[] = [];
  const restore = setJournalSink((message) => messages.push(message));
  try {
    await updateSetting(server.store, CONFIG_SETTINGS_KEY, () => STORED);
    const paws = await start(home, server.url);
    try {
      expect(messages.filter((message) => message.includes("[agents.grok]"))).toEqual([
        "Saved settings [agents.grok] is not known to this Paws and is ignored: remove it in Settings",
      ]);
      const configPath = paws.paths.configFile;
      const listed = await handleAgentSettingsRequest(settingsRequest("GET"), {
        configPath,
        csrfToken: "csrf",
      });
      expect(await listed!.json()).toMatchObject({ retiredSections: ["agents.grok"] });

      const removed = await handleAgentSettingsRequest(
        settingsRequest("DELETE", { section: "agents.grok" }),
        { configPath, csrfToken: "csrf" },
      );
      expect(removed!.status).toBe(200);
      expect(await removed!.json()).not.toHaveProperty("retiredSections");
      expect(await readSetting(server.store, CONFIG_SETTINGS_KEY)).toBe(
        '[agents]\nimplementer = "codex"\n',
      );
      const after = await handleAgentSettingsRequest(settingsRequest("GET"), {
        configPath,
        csrfToken: "csrf",
      });
      expect(await after!.json()).not.toHaveProperty("retiredSections");
    } finally {
      await paws.stop();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
    await server.close();
  }
});

test("an unknown section in config.toml on disk still stops startup", async () => {
  const server = await pgliteServer();
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.toml"), '[agents.grok]\npath = "/usr/local/bin/grok"\n');
    await expect(start(home, server.url)).rejects.toThrow(
      "config.toml line 1 has an unknown section: agents.grok",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    await server.close();
  }
});
