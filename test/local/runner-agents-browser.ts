// Captures a runner card's coding agents before, during and after an update, at desktop and
// 390 px, for visual proof. The Update and Update all runners buttons are clicked for real.
// Usage: bun run build:status && bun --no-env-file test/local/runner-agents-browser.ts <evidence-directory>
import { chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { demoStatus, handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "runner-agents-evidence");
await mkdir(directory, { recursive: true });

const snapshot = demoStatus();
snapshot.source = "live";
const GB = 1024 ** 3;
const id = "01JRUNNER00000000000GOLD01";
type Stage = "before" | "installing" | "waiting" | "failed" | "after";
let stage: Stage = "before";
const posts: { path: string; body: unknown }[] = [];

function codingAgents(now: number) {
  const claude = {
    agent: "claude",
    current: stage === "after" ? "0.31.0" : "0.30.2",
    pending:
      stage === "before" || stage === "after"
        ? null
        : {
            version: "0.31.0",
            status: stage,
            sessions: stage === "waiting" ? 2 : null,
            error:
              stage === "failed"
                ? "Coding agent claude 0.31.0 was not installed: npm's integrity for @agentclientprotocol/claude-agent-acp@0.31.0 is not the one Paws sent"
                : null,
            requestedAt: now - 60_000,
          },
    reportedAt: now - 5_000,
  };
  return [
    claude,
    { agent: "codex", current: "0.12.0", pending: null, reportedAt: now - 5_000 },
    {
      agent: "grok",
      current: "1.4.1",
      pending: null,
      reportedAt: now - 5_000,
    },
  ];
}

function runners() {
  const now = Date.now();
  return [
    {
      id,
      name: "goldbox",
      ownerUserId: "owner",
      status: "active",
      metrics: {
        cpuPercent: 18,
        cpuCount: 16,
        memoryTotalBytes: 32 * GB,
        memoryAvailableBytes: 20 * GB,
        load1: 1.2,
        load5: 0.9,
        load15: 0.7,
        diskTotalBytes: 953 * GB,
        diskFreeBytes: 500 * GB,
        reportedAt: now - 5_000,
      },
      os: { id: "ubuntu", version: "24.04" },
      version: "1.5.0",
      idle: stage !== "waiting",
      slots: { used: stage === "waiting" ? 2 : 0, total: 3 },
      concurrency: { desired: 3, applied: 3, ceiling: 8 },
      agents: [
        { agent: "claude", status: "signed_in", checkedAt: now - 60_000 },
        { agent: "codex", status: "signed_in", checkedAt: now - 60_000 },
      ],
      running:
        stage === "waiting"
          ? [
              {
                runId: "run-1",
                identifier: "PAS-431",
                title: "Retry Closeout after a transient failure",
                phase: "working",
                startedAt: now - 12 * 60_000,
              },
              {
                runId: "run-2",
                identifier: "PAS-432",
                title: "Cache the GitHub App token",
                phase: "closeout",
                startedAt: now - 40 * 60_000,
              },
            ]
          : [],
      codingAgents: codingAgents(now),
    },
  ];
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "runner-agents-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    if (path === "/api/runners")
      return Response.json({
        runners: runners(),
        serverVersion: "1.5.0",
        workspaceReady: true,
        agentVersions: [
          { agent: "claude", offered: "0.31.0", refused: [], checkedAt: now - 3_600_000 },
          { agent: "codex", offered: "0.12.0", refused: [], checkedAt: now - 3_600_000 },
          { agent: "grok", offered: "1.4.1", refused: [], checkedAt: now - 3_600_000 },
        ],
      });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    if (/^\/api\/runners\/[^/]+\/policy$/.test(path))
      return Response.json({ ownerUserId: "owner", sharing: 1 });
    if (request.method === "POST" && path.includes("/coding-agents/")) {
      posts.push({ path, body: await request.json() });
      stage = "installing";
      return Response.json(
        path.endsWith("update-all") ? { requested: 1 } : { ok: true, version: "0.31.0" },
      );
    }
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "runner-agents-fixture",
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
const block = `[aria-labelledby="runner-${id}-coding-agents"]`;

async function capture(page: Page, name: string, selector: string, width: number) {
  const target = page.locator(selector);
  await target.waitFor();
  await target.scrollIntoViewIfNeeded();
  const overflow = Number(
    await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    ),
  );
  const file = `runner-agents-${name}-${width}.png`;
  await target.screenshot({ path: join(directory, file) });
  const text = (await target.innerText()).replace(/\s+/g, " ");
  observations.push({ file, width, overflow, text });
}

try {
  for (const width of [1440, 390]) {
    stage = "before";
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/status/runners/${id}`);
    await capture(page, "1-before", block, width);
    // Update on the card sends the eligible version.
    await page.getByRole("button", { name: "Update to 0.31.0" }).click();
    await page.getByText("0.31.0 was sent to the runner").waitFor();
    await capture(page, "2-installing", block, width);
    stage = "waiting";
    await page.reload();
    await capture(page, "3-waiting", block, width);
    stage = "failed";
    await page.reload();
    await capture(page, "4-failed", block, width);
    stage = "after";
    await page.reload();
    await capture(page, "5-after", block, width);
    // The runner list offers Update all runners while an agent is behind.
    stage = "before";
    await page.goto(`http://127.0.0.1:${server.port}/status/runners`);
    await capture(page, "6-update-all", '[aria-labelledby="agent-catalog-heading"]', width);
    await page.getByRole("button", { name: "Update all runners" }).click();
    await page.getByText("Sent 1 coding agent update to your runners.").waitFor();
    observations.push({ width, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
await writeFile(
  join(directory, "runner-agents-observations.json"),
  `${JSON.stringify({ observations, posts }, null, 2)}\n`,
);
console.log(JSON.stringify({ observations, posts }, null, 2));
const failed = observations.filter(
  (entry) =>
    (typeof entry.overflow === "number" && entry.overflow > 0) ||
    (Array.isArray(entry.errors) && entry.errors.length),
);
if (failed.length) {
  console.error("Horizontal overflow or page errors:", JSON.stringify(failed));
  process.exit(1);
}
