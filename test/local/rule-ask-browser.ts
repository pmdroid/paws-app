import { fixtureProvider, fullStatusFixture } from "../../src/web/test/fixtures";
// The overview's Needs you list with a rule ask, and the "Rule break" card on the issue page,
// against the real status handler.
// Usage: bun run build:status && bun --no-env-file test/local/rule-ask-browser.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = fullStatusFixture();
const question = snapshot.questions[0]!;
const title = "A rule broke on 7f65200 and needs your decision.";
const detail = [
  "Rule api-contract broke: No removed field or route, new required input, or narrowed type. Finding: probe exited 1; P1 finding.",
  "Approve the break for this commit with a reason, or send the finding back to the agent.",
].join("\n");
snapshot.questions = [
  {
    ...question,
    id: "Q-60",
    itemId: "ENG-103",
    runId: null,
    title,
    body: detail,
    context: "",
    options: [],
    recommendedOption: null,
    linkAsk: {
      kind: "rule",
      head: "7f65200aa1",
      title,
      detail,
      link: "https://paws.example/status/issues/ENG-103#rule",
      bypass: {
        policyDigest: "sha256:0eadf4c9d1e2f3",
        passed: ["install", "lint", "format", "typecheck", "test"],
        checks: [
          {
            id: "api-contract",
            kind: "rule",
            state: "failed",
            attempt: 1,
            finding:
              "src/web/src/contract.ts: StatusTask.title was removed\nsrc/server/serve.ts: GET /api/tasks/:id now requires ?workspace",
          },
        ],
      },
    },
  },
];

const provider = fixtureProvider(snapshot);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "admin",
        csrfToken: "ui-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    return (
      (await handleStatusRequest(request, { provider, csrfToken: "ui-fixture" })) ??
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
const errors: string[] = [];
try {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 2800 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.port}/status/`);
      await page.getByRole("link", { name: /^Review rule/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-103#rule$/);
      const card = page.locator("#rule");
      await expect(card.getByRole("heading", { name: "Rule break" })).toBeVisible();
      await expect(card.getByText("StatusTask.title was removed")).toBeVisible();
      await card
        .getByLabel(/^Reason/)
        .fill("The v2 contract drops StatusTask.title; the dashboard ships with it.");
      await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
      await expect(card.getByRole("button", { name: "Send back" })).toBeEnabled();
      await expect
        .poll(() => page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        .toBe(true);
      await card.screenshot({ path: join(directory, `rule-break-${scheme}-${width}.png`) });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Rule ask checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
