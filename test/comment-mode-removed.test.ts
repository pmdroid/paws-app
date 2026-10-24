import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setJournalSink } from "../src/db";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";

async function startupLines(configToml: string | null, env: Record<string, string> = {}) {
  const home = tempHome();
  if (configToml !== null) writeFileSync(join(home, "config.toml"), configToml);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const paws = startPaws({
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
    PAWS_NO_TUNNEL: "1",
    ...env,
  });
  try {
    return lines.join("\n");
  } finally {
    await paws.stop();
    restore();
  }
}

test("startup with comment mode in config.toml says it was removed", async () => {
  const text = await startupLines('[linear]\nmode = "comments"\n');
  expect(text).toContain("comment mode");
  expect(text).toContain("docs/workspace-access.md");
});

test("startup with LINEAR_MODE=comments says it was removed", async () => {
  expect(await startupLines(null, { LINEAR_MODE: "comments" })).toContain("comment mode");
});

test("startup without a Linear mode does not mention comment mode", async () => {
  expect(await startupLines(null)).not.toContain("comment mode");
});
