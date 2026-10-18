import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createProjectHttp } from "../../src/project-execution";
import { demoStatus, handleStatusRequest } from "../../src/web";
import { createProjectFixture } from "./project-fixture";

const f = createProjectFixture();
const snapshot = { ...demoStatus(), source: "live" as const };
const api = createProjectHttp({ db: f.db, tracker: f.tracker, projects: f.projects });
const principal = {
  ...f.actor,
  role: "member" as const,
  authenticatedAt: Date.now(),
  teamIds: ["team"],
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    return (
      (await api(request, principal)) ??
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "project-browser-fixture",
      })) ??
      new Response(null, { status: 404 })
    );
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const directory = process.env.PAWS_PROJECT_SCREENSHOTS;
if (directory) await mkdir(directory, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/status/#/projects`);
  await page.getByLabel("Linear project URL or ID", { exact: true }).fill("project");
  await page.getByRole("button", { name: "Load project", exact: true }).click();
  await page.getByLabel("Lead", { exact: true }).selectOption("lead");
  await page.getByRole("checkbox", { name: "member", exact: true }).check();
  await page.locator('input[name="issue"][value="one"]').check();
  await page.locator('input[name="issue"][value="two"]').check();
  await page.getByRole("button", { name: "Preview selected scope", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve 2 issues", exact: true })).toBeEnabled();
  await expect(page.getByText("1 project issues excluded.", { exact: true })).toBeVisible();
  await page.evaluate("scrollTo(0,0)");
  if (directory)
    await page.screenshot({ path: `${directory}/projects-preview-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Approve 2 issues", exact: true }).click();
  await expect(page.getByText("Scope approved.", { exact: false })).toBeVisible();
  f.projects.register(f.jobs);
  await f.jobs.tick();
  await page.getByRole("button", { name: "Refresh projects", exact: true }).click();
  await expect(
    page.getByText("Waiting for approved dependencies, project controls or refreshed access.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    .toBe(true);
  await page.evaluate("scrollTo(0,0)");
  if (directory)
    await page.screenshot({ path: `${directory}/projects-paused-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByText("Stop project", { exact: true }).click();
  await page.getByRole("button", { name: "Confirm stop", exact: true }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(2);
  expect(errors).toEqual([]);
  console.log(
    "PASS: project preview, exact approval, canonical intake, dependency hold, pause/resume/stop and mobile layout.",
  );
} finally {
  await browser.close();
  await server.stop(true);
  await f.close();
}
