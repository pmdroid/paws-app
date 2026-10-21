import { chromium, expect } from "@playwright/test";
import { join } from "node:path";
import { demoStatus, handleStatusRequest } from "../src/web";

// The run page while a task waits for its agent's usage limit to reset, at desktop and 390 px.
// Set PAWS_UI_EVIDENCE_DIR to keep the screenshots.
const snapshot = demoStatus();
snapshot.source = "live";
const run = snapshot.runs.find((entry) => entry.id === "r-102");
const item = snapshot.items.find((entry) => entry.id === run?.itemId);
if (!run || !item) throw new Error("Demo run r-102 is missing");
item.state = "running";
run.state = "running";
run.pause = {
  reason: "usage_limit",
  agent: "Claude",
  resetsAt: "2026-10-21T18:00:00.000Z",
  resumeAt: "2026-10-21T18:01:00.000Z",
  runner: "agentbox",
};
snapshot.verdicts = snapshot.verdicts.filter((verdict) => verdict.itemId !== item.id);
snapshot.questions = snapshot.questions.filter((question) => question.itemId !== item.id);
const actions: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/execution-controls") {
      if (request.method === "POST") {
        actions.push(((await request.json()) as { action: string }).action);
        return Response.json({ applied: true });
      }
      return Response.json({ available: true, actions: ["stop", "resume_now"] });
    }
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "ui-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors: string[] = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/runs/r-102`);
    const content = page.locator("#content");
    await expect(content.getByText("Paused · usage limit", { exact: true })).toBeVisible();
    await expect(content.getByText("Implementation · paused until 18:00")).toBeVisible();
    await expect(content.getByRole("heading", { name: "Paused", exact: true })).toBeVisible();
    await expect(
      content.getByText("Claude reached its usage limit. Paws continues at 18:00 UTC."),
    ).toBeVisible();
    await expect(content.getByText(/continues the same session on runner agentbox/)).toBeVisible();
    await expect(content.getByRole("button", { name: "Resume now", exact: true })).toBeVisible();
    await expect(content.getByText("Stop", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    if (process.env.PAWS_UI_EVIDENCE_DIR)
      await page.screenshot({
        path: join(process.env.PAWS_UI_EVIDENCE_DIR, `paused-run-${width}.png`),
        fullPage: true,
      });
    await content.getByRole("button", { name: "Resume now", exact: true }).click();
    await expect.poll(() => actions.at(-1)).toBe("resume_now");
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(
    "PASS: paused run page at 1440 and 390 px with reset time, Resume now and Stop, and no horizontal overflow.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
