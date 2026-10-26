import { statusFixture } from "../fixtures/status";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "evidence-versions-evidence");
await mkdir(directory, { recursive: true });

const SCREENS = [
  "Runner card with three sessions · desktop",
  "Runner card with three sessions · 390 px",
  "Idle runner card · desktop",
  "Idle runner card · 390 px",
];
const PUBLISHED = [
  "2026-10-23T15:35:00.000Z",
  "2026-10-23T16:15:00.000Z",
  "2026-10-23T17:56:00.000Z",
];

const snapshot = statusFixture();
snapshot.source = "live";
const run = snapshot.runs.find((entry) => entry.id === "r-102")!;
snapshot.evidence = PUBLISHED.flatMap((publishedAt, copy) =>
  SCREENS.map((displayName, index) => ({
    id: `ev-${copy}-${index}`,
    itemId: run.itemId,
    runId: run.id,
    checkId: "visual-proof",
    attempt: copy + 1,
    kind: "image" as const,
    mediaType: "image/png",
    displayName,
    sizeBytes: 48_000,
    headCommit: "7439e989".padEnd(40, "0"),
    publishedAt,
    publisher: "Claude",
  })),
);

function picture(id: string): string {
  const [, copy, index] = id.split("-").map(Number);
  const name = SCREENS[index ?? 0] ?? id;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="hsl(${(index ?? 0) * 70 + 180} 60% 85%)"/><text x="64" y="380" font-family="sans-serif" font-size="56">${name} · copy ${(copy ?? 0) + 1}</text></svg>`;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "evidence-versions-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    if (path.startsWith("/api/evidence/"))
      return new Response(picture(decodeURIComponent(path.slice("/api/evidence/".length))), {
        headers: { "content-type": "image/svg+xml" },
      });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "evidence-versions-fixture",
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
const observations: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390])
    for (const open of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/status/runs/r-102`);
      const gallery = page.getByRole("region", { name: "Evidence" });
      await gallery.waitFor();
      const tiles = await gallery.locator("[data-evidence-tile]").count();
      const folds = await gallery.getByText("Earlier versions (2)").count();
      if (open) await gallery.getByText("Earlier versions (2)").first().click();
      await gallery.scrollIntoViewIfNeeded();
      const overflow = Number(
        await page.evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      );
      const name = `pas-583-${width}${open ? "-open" : ""}.png`;
      await gallery.screenshot({ path: join(directory, name) });
      observations.push({ name, width, open, tiles, folds, overflow, errors });
      await page.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
await writeFile(
  join(directory, "pas-583-observations.json"),
  `${JSON.stringify(observations, null, 2)}\n`,
);
console.log(JSON.stringify(observations));
const failed = observations.filter(
  (entry) =>
    entry.tiles !== 4 ||
    entry.folds !== 4 ||
    (entry.overflow as number) > 0 ||
    (entry.errors as string[]).length,
);
if (failed.length) {
  console.error(
    "Wrong tiles or folds, horizontal overflow or page errors:",
    JSON.stringify(failed),
  );
  process.exit(1);
}
