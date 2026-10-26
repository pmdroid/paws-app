import { statusFixture } from "../fixtures/status";
// Draws on the screenshots of a waiting visual review at desktop (mouse) and 390 px (touch), sends
// Request changes, and checks the marked PNGs keep each screenshot's size, then captures the pages.
// Fails on horizontal scroll, page errors, or a missing or misplaced mark.
// Usage: bun run build:status && bun --no-env-file test/local/review-draw-browser.ts <evidence-directory>
import { chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "review-draw-evidence");
await mkdir(directory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});

async function screen(title: string, color: string): Promise<Uint8Array> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
  await page.setContent(
    `<body style="margin:0;font:24px sans-serif;background:#f6f6f2"><header style="background:${color};color:white;padding:24px 40px;font-weight:700">${title}</header><main style="padding:40px;display:grid;gap:24px;max-width:640px"><label>Model<br><input style="font:inherit;width:100%" value="claude-opus"></label><label>Reasoning<br><input style="font:inherit;width:100%" value="high"></label><button style="font:inherit;justify-self:end;margin-right:-60px;padding:12px 32px">Save</button></main></body>`,
  );
  const bytes = await page.screenshot();
  await page.close();
  return bytes;
}

const files = new Map<string, Uint8Array>([
  ["shot-1", await screen("Agent settings", "#5b4bdb")],
  ["shot-2", await screen("Merge settings", "#0f766e")],
]);

function fixture() {
  const snapshot = statusFixture();
  snapshot.source = "live";
  const run = snapshot.runs.find((entry) => entry.id === "r-102")!;
  const item = snapshot.items.find((entry) => entry.id === run.itemId)!;
  item.state = "awaiting_input";
  item.owner = "Ada Reviewer";
  run.state = "awaiting_input";
  snapshot.verdicts = snapshot.verdicts.filter((verdict) => verdict.itemId !== item.id);
  snapshot.agentCloseout = [];
  snapshot.evidence = ["shot-1", "shot-2"].map((id) => ({
    id,
    itemId: item.id,
    runId: run.id,
    checkId: "visual-proof",
    attempt: 1,
    kind: "image" as const,
    mediaType: "image/png" as const,
    displayName: `${id === "shot-1" ? "agent" : "merge"}-settings.png`,
    sizeBytes: files.get(id)!.byteLength,
    headCommit: "a".repeat(40),
    publishedAt: snapshot.generatedAt,
    publisher: "Claude",
  }));
  item.visualReviews = [
    {
      questionId: "q-1",
      checkId: "visual-proof",
      round: 1,
      state: "waiting",
      evidenceIds: ["shot-1", "shot-2"],
      commit: "a".repeat(40),
      askedAt: snapshot.generatedAt,
      answeredBy: null,
      answeredAt: null,
      feedback: null,
    },
  ];
  snapshot.questions = [];
  return { snapshot, item };
}

let state = fixture();
const posted: { note: string; marks: { evidenceId: string; width: number; height: number }[] }[] =
  [];

function size(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "ada",
        role: "owner",
        csrfToken: "review-draw-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Ada Reviewer" },
      });
    if (path.startsWith("/api/evidence/")) {
      const bytes = files.get(decodeURIComponent(path.slice("/api/evidence/".length)));
      return bytes
        ? new Response(bytes, { headers: { "content-type": "image/png" } })
        : new Response(null, { status: 404 });
    }
    if (path === "/api/visual-review-changes" && request.method === "POST") {
      if (request.headers.get("x-paws-csrf") !== "review-draw-fixture")
        return Response.json({ error: "csrf" }, { status: 403 });
      const form = await request.formData();
      const marks: (typeof posted)[number]["marks"] = [];
      const review = state.item.visualReviews![0]!;
      review.marks = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith("mark:") || typeof value === "string") continue;
        const evidenceId = key.slice("mark:".length);
        const bytes = new Uint8Array(await value.arrayBuffer());
        files.set(`mark-${evidenceId}`, bytes);
        review.marks.push({ id: `mark-${evidenceId}`, evidenceId });
        marks.push({ evidenceId, ...size(bytes) });
      }
      posted.push({ note: String(form.get("note")), marks });
      Object.assign(review, {
        state: "changes_requested",
        answeredBy: "Ada Reviewer",
        answeredAt: state.snapshot.generatedAt,
        feedback: String(form.get("note")),
      });
      state.item.state = "running";
      return Response.json({ ok: true });
    }
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => state.snapshot },
        csrfToken: "review-draw-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});

async function stroke(page: Page, touch: boolean, points: [number, number][]) {
  const box = (await page.locator("[data-draw-canvas]").boundingBox())!;
  const at = ([x, y]: [number, number]) => ({
    x: box.x + x * box.width,
    y: box.y + y * box.height,
  });
  if (!touch) {
    await page.mouse.move(at(points[0]!).x, at(points[0]!).y);
    await page.mouse.down();
    for (const point of points.slice(1))
      await page.mouse.move(at(point).x, at(point).y, { steps: 4 });
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const touchPoint = (point: [number, number]) => [{ ...at(point), id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touchPoint(points[0]!),
  });
  for (const point of points.slice(1))
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touchPoint(point),
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const circle: [number, number][] = Array.from({ length: 25 }, (_, step) => {
  const angle = (step / 24) * Math.PI * 2;
  return [0.65 + 0.1 * Math.cos(angle), 0.34 + 0.09 * Math.sin(angle)];
});

const observations: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390]) {
    state = fixture();
    const touch = width < 768;
    const page = await browser.newPage({
      viewport: { width, height: touch ? 844 : 1000 },
      ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : {}),
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const overflow = async () =>
      Number(
        await page.evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      );
    await page.goto(`http://127.0.0.1:${server.port}/status/#/runs/r-102`);
    const open = page.getByRole("button", { name: "Draw on screenshots" });
    await open.waitFor();
    await page.screenshot({
      path: join(directory, `pas-513-${width}-waiting.png`),
      fullPage: touch,
    });
    const pageOverflow = await overflow();
    await open.click();
    await page.locator("[data-draw-canvas]").waitFor();
    await page.waitForFunction("document.querySelector('[data-draw-image]').complete");
    await stroke(page, touch, circle);
    await stroke(page, touch, [
      [0.3, 0.2],
      [0.5, 0.2],
    ]);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.locator("[data-draw-shot='1']").click();
    await page.waitForFunction("document.querySelector('[data-draw-image]').complete");
    await stroke(page, touch, [
      [0.1, 0.1],
      [0.3, 0.12],
      [0.2, 0.25],
    ]);
    await page.locator("[data-draw-shot='0']").click();
    await page.waitForFunction("document.querySelector('[data-draw-image]').complete");
    await page.locator("[data-draw-note]").fill("Move the Save button back inside the form.");
    await page.screenshot({ path: join(directory, `pas-513-${width}-drawing.png`) });
    const dialogOverflow = await overflow();
    const ink = Number(
      await page.evaluate(`(() => {
        const canvas = document.querySelector("[data-draw-canvas]");
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const x = Math.round(0.75 * canvas.width), y = Math.round(0.34 * canvas.height);
        let red = 0;
        for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
          const i = ((y + dy) * canvas.width + x + dx) * 4;
          if (data[i] > 200 && data[i + 1] < 120 && data[i + 3] > 0) red++;
        }
        return red;
      })()`),
    );
    await page.getByRole("button", { name: "Request changes" }).click();
    await page.getByText("Marked by the reviewer").first().waitFor();
    await page.screenshot({ path: join(directory, `pas-513-${width}-sent.png`), fullPage: touch });
    observations.push({
      width,
      touch,
      overflow: Math.max(pageOverflow, dialogOverflow, await overflow()),
      ink,
      errors,
      posted: posted.at(-1),
    });
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
await writeFile(
  join(directory, "pas-513-observations.json"),
  `${JSON.stringify(observations, null, 2)}\n`,
);
console.log(JSON.stringify(observations, null, 2));
const failed = observations.filter((entry) => {
  const sent = entry.posted as (typeof posted)[number] | undefined;
  return (
    (entry.overflow as number) > 0 ||
    (entry.errors as string[]).length ||
    (entry.ink as number) === 0 ||
    sent?.note !== "Move the Save button back inside the form." ||
    sent.marks.map((mark) => mark.evidenceId).join() !== "shot-1,shot-2" ||
    sent.marks.some((mark) => mark.width !== 1200 || mark.height !== 750)
  );
});
if (failed.length) {
  console.error("Review drawing failed:", JSON.stringify(failed));
  process.exit(1);
}
