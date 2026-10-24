// Captures the runner card at desktop and 390 px in light and dark, for visual proof.
// Usage: bun run build:status && bun --no-env-file test/local/runner-card-browser.ts <evidence-directory> [prefix]
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { demoStatus, handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "runner-card-evidence");
const prefix = process.argv[3] ?? "runner-card";
await mkdir(directory, { recursive: true });

const snapshot = demoStatus();
snapshot.source = "live";
const GB = 1024 ** 3;
const busy = "01JRUNNER0000000000000BUSY";
const calm = "01JRUNNER0000000000000CALM";
function runners() {
  const now = Date.now();
  return [
    {
      id: busy,
      name: "build-box",
      ownerUserId: "owner",
      status: "active",
      metrics: {
        cpuPercent: 100,
        cpuCount: 16,
        memoryTotalBytes: 28 * GB,
        memoryAvailableBytes: 16 * GB,
        load1: 24.86,
        load5: 10.59,
        load15: 5.98,
        diskTotalBytes: 953 * GB,
        diskFreeBytes: 223 * GB,
        strayProcesses: [
          { pid: 2184572, name: "bun", ageSeconds: 5 * 3600 + 120, cpuPercent: 161.2 },
          { pid: 2184573, name: "bun", ageSeconds: 5 * 3600 + 120, cpuPercent: 158.7 },
          { pid: 2127564, name: "bg.sh", ageSeconds: 9 * 3600 + 2400, cpuPercent: 0 },
        ],
        reportedAt: now - 5_000,
      },
      os: { id: "ubuntu", version: "24.04" },
      version: "1.4.0",
      idle: false,
      slots: { used: 3, total: 3 },
      concurrency: { desired: 3, applied: 3, ceiling: 10 },
      agents: [
        {
          agent: "claude",
          status: "signed_in",
          checkedAt: now - 60_000,
          limits: [
            { window: "5-hour", usedPercent: 7, resetsAt: now + 3 * 3_600_000 },
            { window: "Weekly", usedPercent: 2, resetsAt: now + 4 * 86_400_000 },
          ],
        },
        {
          agent: "codex",
          status: "usage_limit",
          checkedAt: now - 60_000,
          limits: [{ window: "Weekly", usedPercent: 100, resetsAt: now + 6 * 86_400_000 }],
        },
        { agent: "grok", status: "signed_out", checkedAt: now - 60_000 },
      ],
      running: [
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
        {
          runId: "run-3",
          identifier: "PAS-1207",
          title: "Show queued work on Overview",
          phase: "fixing",
          startedAt: now - 75 * 60_000,
        },
      ],
    },
    {
      id: calm,
      name: "spare-box",
      ownerUserId: "owner",
      status: "active",
      metrics: {
        cpuPercent: 12,
        memoryTotalBytes: 16 * GB,
        memoryAvailableBytes: 11 * GB,
        load1: 0.42,
        load5: 0.31,
        load15: 0.2,
        diskTotalBytes: 500 * GB,
        diskFreeBytes: 410 * GB,
        reportedAt: now - 45_000,
      },
      os: { id: "debian", version: "12" },
      version: "1.3.0",
      idle: true,
      slots: { used: 0, total: 2 },
      concurrency: { desired: 2, applied: 2, ceiling: 4 },
      agents: [{ agent: "claude", status: "signed_in", checkedAt: now - 60_000 }],
      running: [],
    },
  ];
}

function usage(runnerId: string) {
  const now = Date.now();
  const row = (commandId: string, outcome: string | null, identifier: string, title: string) => ({
    commandId,
    runnerId,
    runnerName: runnerId === busy ? "build-box" : "spare-box",
    runId: `run-${commandId}`,
    identifier,
    title,
    agent: "claude",
    resolvedModel: "claude-opus-5-5",
    modelLabel: "Opus 5.5",
    purpose: "work",
    outcome,
    startedAt: now - 3 * 3_600_000,
    endedAt: outcome === null ? null : now - 2 * 3_600_000,
  });
  return [
    row("cmd-1", null, "PAS-431", "Retry Closeout after a transient failure"),
    row("cmd-2", "infrastructure_error", "PAS-1207", "Show queued work on Overview"),
    row("cmd-3", "success", "PAS-432", "Cache the GitHub App token"),
  ];
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
        csrfToken: "runner-card-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: runners(), serverVersion: "1.4.0", workspaceReady: true });
    if (path === "/api/runners/usage")
      return Response.json({
        usage: usage(new URL(request.url).searchParams.get("runner") ?? ""),
      });
    if (/^\/api\/runners\/[^/]+\/policy$/.test(path))
      return Response.json({ ownerUserId: "owner", sharing: 1 });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "runner-card-fixture",
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
    for (const scheme of ["light", "dark"] as const)
      for (const id of [busy, calm]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        await page.emulateMedia({ colorScheme: scheme });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/status/runners/${id}`);
        const card = page.locator(`[data-runner-card="${id}"]`);
        await card.waitFor();
        await page.locator("#runner-history-heading + div table").waitFor();
        // A string expression, because this file type-checks without the DOM library.
        const overflow = Number(
          await page.evaluate(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        );
        const tableOverflow = Number(
          await page.evaluate(
            "(() => { const box = document.querySelector('#runner-history-heading + div table').parentElement; return box.scrollWidth - box.clientWidth; })()",
          ),
        );
        const name = `${prefix}-${id === busy ? "busy" : "calm"}-${width}-${scheme}.png`;
        // The sticky toolbar covers a scrolled card on phones, so phones capture the whole page.
        if (width < 768) await page.screenshot({ path: join(directory, name), fullPage: true });
        else await card.screenshot({ path: join(directory, name) });
        observations.push({ name, width, scheme, overflow, tableOverflow, errors });
        await page.close();
      }
} finally {
  await browser.close();
  server.stop(true);
}
await writeFile(
  join(directory, `${prefix}-observations.json`),
  `${JSON.stringify(observations, null, 2)}\n`,
);
console.log(JSON.stringify(observations));
const failed = observations.filter(
  (entry) =>
    (entry.overflow as number) > 0 ||
    (entry.tableOverflow as number) > 0 ||
    (entry.errors as string[]).length,
);
if (failed.length) {
  console.error("Horizontal overflow or page errors:", JSON.stringify(failed));
  process.exit(1);
}
