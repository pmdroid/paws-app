import { statusFixture } from "../src/web/test/fixtures";
// The overview's Needs you list with the four kinds of link asks, the "Closeout needs your
// help" card and the Risk card on the issue page, against the real status handler, and the
// risk gate note in Settings › Merging on a Paws without an https link.
// Usage: bun run build:status && bun --no-env-file scripts/verify-link-ask-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RISK_GATE_NEEDS_PUBLIC_URL } from "../src/loop";
import { handleMergeSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const template = snapshot.items.find((item) => item.id === "ENG-103")!;
const question = snapshot.questions[0]!;
const add = (id: string, title: string) =>
  snapshot.items.push({ ...template, id, title, runId: null, links: [] });
add("ENG-105", "Audit settings page");
add("ENG-106", "Session token rotation");
const linkAsk = (
  id: string,
  itemId: string,
  kind: "bypass" | "screenshots" | "risk" | "question",
  head: string,
  title: string,
  detail: string,
  anchor: string,
) => ({
  ...question,
  id,
  itemId,
  runId: null,
  title,
  body: detail,
  context: "",
  options: [],
  recommendedOption: null,
  linkAsk: {
    kind,
    head,
    title,
    detail,
    link: `https://paws.example/status/issues/${itemId}#${anchor}`,
  },
});
const questions = [
  linkAsk(
    "Q-50",
    "ENG-103",
    "bypass",
    "7f65200aa1",
    "Closeout needs your decision on 7f65200.",
    "Closeout stopped on 7f65200: 1 check failed (independent-review). Bypass a failed check for this commit with a reason, send the agent guidance, or stop.",
    "closeout",
  ),
  linkAsk(
    "Q-51",
    "ENG-105",
    "screenshots",
    "4b317d5bb2",
    "The screens of 4b317d5 need your visual review.",
    "3 changed screens wait for your visual review of 4b317d5.",
    "visual-review",
  ),
  linkAsk(
    "Q-52",
    "ENG-106",
    "risk",
    "c0ffee1cc3",
    "High-risk changes in c0ffee1 need your approval.",
    "High-risk paths changed: src/auth/session.ts. Approve before merge.",
    "risk",
  ),
  linkAsk(
    "Q-53",
    "ENG-100",
    "question",
    "9a8b7c6dd4",
    "Paws needs your answer on 9a8b7c6.",
    "How long should export download links stay valid?",
    "question",
  ),
];
questions[0]!.linkAsk = {
  ...questions[0]!.linkAsk,
  bypass: {
    policyDigest: "sha256:0eadf4c9d1e2f3",
    passed: ["install", "lint", "format", "typecheck", "test", "build-status", "links"],
    checks: [
      {
        id: "independent-review",
        kind: "review",
        state: "failed",
        attempt: 1,
        finding:
          "docs/smoke-test.md: Recorded runs\nThe required live smoke runs remain incomplete. The fake-based rehearsal cannot verify Linear rendering, GitHub webhook delivery or live merge behaviour.",
      },
    ],
  },
};
questions[2]!.linkAsk = {
  ...questions[2]!.linkAsk,
  risk: {
    paths: ["src/auth/session.ts", "src/auth/tokens.ts"],
    summary: "Closeout accepted c0ffee1: 9 checks passed.",
    findings: [
      {
        id: "independent-review",
        finding:
          "P3 src/auth/session.ts: the previous token stays valid for 60 seconds after rotation. Intended, and covered by a test.",
      },
    ],
  },
};
snapshot.questions = questions;

const configPath = join(mkdtempSync(join(tmpdir(), "paws-risk-gate-")), "config.toml");
writeFileSync(configPath, '[merge]\norder = "queue"\nmain_moved = "closeout"\n');

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    // A Paws that only listens on localhost: Settings › Merging says why the risk gate is off.
    const merging = await handleMergeSettingsRequest(request, {
      configPath,
      csrfToken: "ui-fixture",
      riskGate: { on: false, reason: RISK_GATE_NEEDS_PUBLIC_URL },
    });
    if (merging) return merging;
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
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.port}/status/`);
      for (const name of ["Review bypass", "Review screenshots", "Review risk", "Answer question"])
        await expect(page.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(directory, `needs-you-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("link", { name: /^Review bypass/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-103#closeout$/);
      const card = page.locator("#closeout");
      await expect(card.getByRole("heading", { name: "Closeout needs your help" })).toBeVisible();
      await expect(card.getByRole("checkbox", { name: /independent-review/ })).toBeChecked();
      await card
        .getByLabel("Why bypass independent-review?")
        .fill("The live smoke run cannot run from a runner and moved to PAS-744.");
      await expect(
        card.getByRole("button", { name: "Bypass 1 check for 7f65200 and re-verify" }),
      ).toBeEnabled();
      await expect(card.getByRole("button", { name: "Send guidance instead" })).toBeVisible();
      await expect(card.getByText("Stop", { exact: true })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `closeout-help-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.goto(`http://127.0.0.1:${server.port}/status/`);
      await page.getByRole("link", { name: /^Review risk/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-106#risk$/);
      const risk = page.locator("#risk");
      await expect(risk.getByRole("heading", { name: "Risk", exact: true })).toBeVisible();
      await expect(risk.getByText("src/auth/session.ts", { exact: true })).toBeVisible();
      await expect(risk.getByText("Closeout accepted c0ffee1: 9 checks passed.")).toBeVisible();
      await expect(risk.getByRole("button", { name: "Approve c0ffee1" })).toBeEnabled();
      await expect(risk.getByRole("button", { name: "Request changes" })).toBeEnabled();
      await risk.getByText("Stop", { exact: true }).click();
      await expect(risk.getByRole("button", { name: "Confirm stop" })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `risk-card-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.goto(`http://127.0.0.1:${server.port}/status/settings/merging`);
      const gate = page.locator("#merge-risk-gate");
      await expect(gate.getByRole("heading", { name: "High-risk approval" })).toBeVisible();
      await expect(gate).toContainText("Set PAWS_PUBLIC_URL to an https address.");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await gate.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(directory, `risk-gate-settings-${scheme}-${width}.png`) });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Link ask checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
