import { statusFixture } from "../src/web/test/fixtures";
// The Visual review card on the issue page while its screenshots link ask is open, against the
// real status handler: the changed screens, a mark drawn on one, and the three decisions.
// Usage: bun run build:status && bun --no-env-file scripts/verify-visual-review-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StatusEvidence } from "../src/web/src/contract";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const HEAD = "4b317d5".padEnd(40, "e");
const BEFORE = "9f1c2aa".padEnd(40, "f");
const SCREENS = [
  { id: "shot-wide", name: "Settings › Audit · 1440px", width: 1440 },
  { id: "shot-narrow", name: "Settings › Audit · 390px", width: 390 },
  { id: "shot-warnings", name: "Issue page · warnings", width: 1440 },
];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});

/** A stand-in for each screenshot the agent published: a settings page with rows and buttons. */
const images = new Map<string, Uint8Array>();
for (const screen of SCREENS) {
  const page = await browser.newPage({ viewport: { width: screen.width, height: 900 } });
  const rows = Array.from(
    { length: 7 },
    (_, n) =>
      `<li><span style="width:${40 + ((n * 17) % 40)}%"></span><button>Retry export ${n + 1}</button></li>`,
  ).join("");
  await page.setContent(
    `<style>body{margin:0;font:16px system-ui;background:#f5f3ff;color:#1e1b4b}header{padding:16px 24px;background:#fff;border-bottom:2px solid #1e1b4b;font-weight:700}ul{list-style:none;margin:24px;padding:0;display:grid;gap:12px}li{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}span{height:12px;background:#a5a1d6;border-radius:6px}button{border:2px solid #1e1b4b;background:#fff;padding:6px 12px;border-radius:5px}</style><header>${screen.name}</header><ul>${rows}</ul>`,
  );
  images.set(screen.id, await page.screenshot());
  await page.close();
}

const snapshot = statusFixture();
snapshot.source = "live";
const item = snapshot.items.find((entry) => entry.id === "ENG-103")!;
const run = snapshot.runs.find((entry) => entry.itemId === item.id)!;
item.state = "awaiting_input";
item.owner = "Jonas Berg";
run.state = "awaiting_input";
const shot = (id: string, name: string, commit: string): StatusEvidence => ({
  id,
  itemId: item.id,
  runId: run.id,
  checkId: "visual-proof",
  attempt: 1,
  kind: "image",
  mediaType: "image/png",
  displayName: name,
  sizeBytes: images.get(id)?.byteLength ?? 2048,
  headCommit: commit,
  publishedAt: "2026-10-26T21:00:00.000Z",
  publisher: "Claude",
});
snapshot.evidence = [
  ...SCREENS.map((screen) => shot(screen.id, screen.name, HEAD)),
  shot("shot-old", "Settings › Audit · 390px", BEFORE),
];
images.set("shot-old", images.get("shot-narrow")!);
item.visualReviews = [
  {
    questionId: "Q-40",
    checkId: "visual-proof",
    round: 1,
    state: "changes_requested",
    evidenceIds: ["shot-old"],
    commit: BEFORE,
    askedAt: "2026-10-26T20:30:00.000Z",
    answeredBy: "Pascal",
    answeredAt: "2026-10-26T20:40:00.000Z",
    feedback: "Keep the Retry button on the same line as the status.",
    marks: [
      { id: "shot-old", evidenceId: "shot-old" },
      { id: "shot-old", evidenceId: "shot-old" },
    ],
  },
  {
    questionId: "Q-41",
    checkId: "visual-proof",
    round: 2,
    state: "waiting",
    evidenceIds: SCREENS.map((screen) => screen.id),
    commit: HEAD,
    askedAt: "2026-10-26T21:01:00.000Z",
    answeredBy: null,
    answeredAt: null,
    feedback: null,
  },
];
const title = "The screens of 4b317d5 need your visual review.";
const detail =
  "3 changed screens for visual-proof: Settings › Audit · 1440px, Settings › Audit · 390px, Issue page · warnings.";
snapshot.questions = [
  {
    ...snapshot.questions[0]!,
    id: "Q-41",
    itemId: item.id,
    runId: run.id,
    title,
    body: detail,
    context: "",
    options: [],
    recommendedOption: null,
    links: [],
    linkAsk: {
      kind: "screenshots",
      head: HEAD,
      title,
      detail,
      link: `https://paws.example/status/issues/${item.id}#visual-review`,
    },
  },
];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    const image = images.get(decodeURIComponent(path.replace(/^\/api\/evidence\//, "")));
    if (path.startsWith("/api/evidence/") && image)
      return new Response(image, { headers: { "content-type": "image/png" } });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "ui-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});
const errors: string[] = [];
try {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 2600 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.port}/status/`);
      await page.getByRole("link", { name: /^Review screenshots/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-103#visual-review$/);
      const card = page.locator("#visual-review");
      await expect(card.getByRole("heading", { name: "Visual review" })).toBeVisible();
      await expect(card.locator(".visual-review-frame img")).toHaveCount(3);
      await expect(card.getByText("Changes requested by Pascal · 2 marks")).toBeVisible();

      // Draw one mark on the narrow screenshot; it stays on the card.
      await card.locator('[data-evidence-id="shot-narrow"]').click();
      const canvas = page.locator("dialog.review-draw canvas");
      await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.3);
      await page.mouse.down();
      for (const [x, y] of [
        [0.9, 0.3],
        [0.9, 0.45],
        [0.55, 0.45],
        [0.55, 0.3],
      ] as const)
        await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 6 });
      await page.mouse.up();
      await page.locator("dialog.review-draw").getByRole("button", { name: "Done" }).click();
      await expect(card.getByRole("button", { name: "Request changes (1 mark)" })).toBeVisible();
      await expect(card.locator(".review-marks polyline")).toHaveCount(1);
      await expect(card.getByRole("button", { name: "Approve 4b317d5" })).toBeVisible();
      await expect(card.getByText("Stop", { exact: true })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await card.screenshot({ path: join(directory, `visual-review-card-${scheme}-${width}.png`) });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Visual review checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
