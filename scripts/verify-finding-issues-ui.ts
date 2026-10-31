// The issue page's Review findings card: File an issue on a pre-existing finding, Linear's
// error beside the button, then the "PAS-123 filed" link, against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-finding-issues-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FINDING_ISSUE_PATH, handleStatusRequest } from "../src/web";
import type { StatusReviewFinding } from "../src/web/src/contract";
import { fixtureProvider, fullStatusFixture } from "../src/web/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const finding = (
  severity: StatusReviewFinding["severity"],
  location: string,
  explanation: string,
  evidence: string,
  marks: Partial<StatusReviewFinding> = {},
): StatusReviewFinding => ({
  severity,
  location,
  explanation,
  evidence,
  preExisting: false,
  blocking: false,
  since: null,
  ...marks,
});

const legacy = finding(
  "P2",
  "src/retention/legacy.ts:7",
  "unchecked null: the legacy reader reads row.id before it checks that the export returned a row",
  "legacy.ts:7 dereferences row with no guard; the export returns null for an empty window.",
  { preExisting: true, since: "new" },
);
let filed = false;
let fail = true;

function status() {
  const full = fullStatusFixture();
  const verdict = full.verdicts.find((entry) => entry.itemId === "ENG-100")!;
  verdict.reviews = [
    {
      id: "independent-review",
      rounds: [
        {
          attempt: 1,
          baseSha: "a1c9e07",
          headSha: "91fd0c4e5b2a",
          failOn: "P1",
          findings: [
            finding(
              "P1",
              "src/retention/job.ts:44",
              "ordering: deletes rows before the export finishes",
              "job.ts:44 calls purge() before await export().",
              { blocking: true },
            ),
            filed
              ? {
                  ...legacy,
                  filed: { identifier: "PAS-123", url: "https://linear.app/kyku/issue/PAS-123" },
                }
              : legacy,
          ],
          fixed: [],
        },
      ],
    },
    {
      id: "security-review",
      rounds: [
        {
          attempt: 1,
          baseSha: "a1c9e07",
          headSha: "91fd0c4e5b2a",
          failOn: "P1",
          findings: [
            finding(
              "P3",
              "src/retention/export.ts:120",
              "log exposure: the export logs the bucket path, which names the customer",
              "export.ts:120 logs `s3://exports/${customer}/`.",
              { preExisting: true, since: "new" },
            ),
          ],
          fixed: [],
        },
      ],
    },
  ];
  return full;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    if (path === FINDING_ISSUE_PATH && request.method === "POST") {
      if (fail)
        return Response.json(
          { error: "Linear did not file the issue: Linear rate limit reached. Try again." },
          { status: 502 },
        );
      filed = true;
      return Response.json({
        identifier: "PAS-123",
        url: "https://linear.app/kyku/issue/PAS-123",
        filed: true,
      });
    }
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(status),
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
      filed = false;
      fail = true;
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-100`);
      const card = page.locator("section.review-findings");
      await expect(card.getByRole("heading", { name: "Review findings" })).toBeVisible();
      const buttons = card.getByRole("button", { name: "File an issue" });
      // One per pre-existing finding, from both reviews; none on the blocking finding.
      await expect(buttons).toHaveCount(2);
      const shot = async (name: string) => {
        // Away from the button, so the shot shows its resting state, not its hover.
        await page.mouse.move(0, 0);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await card.screenshot({ path: join(directory, `findings-${name}-${scheme}-${width}.png`) });
      };
      await shot("before");
      await buttons.first().click();
      await expect(card.getByRole("alert")).toContainText("Linear rate limit reached");
      await shot("error");
      fail = false;
      await buttons.first().click();
      await expect(card.getByRole("link", { name: "PAS-123 filed" })).toBeVisible();
      await expect(buttons).toHaveCount(1);
      await shot("after");
      // A reload reads the filed issue from the issue page's data.
      await page.reload();
      await expect(card.getByRole("link", { name: "PAS-123 filed" })).toBeVisible();
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Finding issue checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
