const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = process.argv[2],
    bun = process.argv[3];
  fs.mkdirSync(root, { recursive: true });
  const child = spawn(bun, ["--no-env-file", "test/local/agent-transcript.ts", root], {
    cwd: path.resolve(__dirname, "../.."),
    stdio: ["ignore", "pipe", "inherit"],
  });
  let browser;
  try {
    const manifest = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Fixture timeout")), 10000);
      child.once("exit", (code) => reject(Error(`Fixture exited ${code}`)));
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.origin) {
            clearTimeout(timer);
            resolve(value);
          }
        } catch {}
      });
    });
    browser = await chromium.launch({ headless: true });
    const observations = [],
      errors = [];
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === manifest.origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${manifest.origin}/status/runs/${manifest.runId}`);
      const link = page.getByRole("link", { name: "Open full agent transcript" });
      await link.waitFor();
      assert.equal(await page.getByRole("log", { name: "Agent transcript" }).count(), 0);
      const body = await page.locator("body").innerText();
      assert(!body.includes("Opening the create VM dialog"));
      assert(!body.includes("private reasoning"));
      if (name === "desktop") await page.request.post(`${manifest.origin}/__append`);
      const [fullTranscript] = await Promise.all([context.waitForEvent("page"), link.click()]);
      await fullTranscript.waitForURL(
        `${manifest.origin}/status/runs/${manifest.runId}/transcript`,
      );
      fullTranscript.on("pageerror", (error) => errors.push(String(error)));
      const log = fullTranscript.getByRole("log", { name: "Agent transcript" });
      await log.getByText("Screenshot captured on the runner", { exact: true }).waitFor();
      const fullText = await log.innerText();
      assert(fullText.includes("Opening the create VM dialog"));
      assert(fullText.includes("Launch Chromium"));
      assert(!(await fullTranscript.locator("body").innerText()).includes("private reasoning"));
      assert.equal(await fullTranscript.getByRole("navigation").count(), 0);
      assert.equal(
        await fullTranscript.getByRole("heading", { name: "Agent transcript" }).count(),
        1,
      );
      assert.equal(
        await fullTranscript.getByRole("banner").getByText("Agent transcript").count(),
        1,
      );
      assert.equal(await fullTranscript.getByRole("status").innerText(), "Auto-updating");
      const atBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      await fullTranscript.waitForFunction(atBottom);
      assert(await fullTranscript.evaluate(() => scrollY > 0));
      const jump = fullTranscript.getByRole("button", { name: /Jump to latest message/ });
      assert.equal(await jump.count(), 0);
      await fullTranscript.screenshot({ path: path.join(root, `${name}-transcript-latest.png`) });
      await fullTranscript.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await jump.waitFor();
      const followUp = `Capture ${name} screenshot`;
      await fullTranscript.request.post(
        `${manifest.origin}/__append?tool=${encodeURIComponent(followUp)}`,
      );
      await log.getByText(`${followUp} · completed`, { exact: true }).waitFor();
      assert(await fullTranscript.evaluate(() => scrollY < 8));
      await fullTranscript.getByRole("button", { name: "Jump to latest message, 1 new" }).waitFor();
      await fullTranscript.screenshot({ path: path.join(root, `${name}-transcript-scrolled.png`) });
      await jump.click();
      await fullTranscript.waitForFunction(atBottom);
      await jump.waitFor({ state: "detached" });
      assert(
        await fullTranscript.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
      if (name === "desktop") {
        await fullTranscript.emulateMedia({ colorScheme: "dark" });
        await fullTranscript.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await jump.waitFor();
        await fullTranscript.screenshot({ path: path.join(root, "desktop-transcript-dark.png") });
      }
      await fullTranscript.close();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, `${name}.png`), fullPage: true });
      observations.push({
        name,
        inlineTranscriptHidden: true,
        toolVisible: true,
        fullTranscriptLink: true,
        transcriptPageWithoutNavigation: true,
        autoscrollsToLatest: true,
        holdsPositionWhenScrolledBack: true,
        jumpToLatest: true,
        privateReasoningHidden: true,
        noHorizontalOverflow: true,
        passed: true,
      });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify(observations));
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
