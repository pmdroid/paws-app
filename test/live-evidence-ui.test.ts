import { describe, expect, test } from "bun:test";
import {
  insertQueuedItem,
  insertRun,
  migrate,
  openDatabase,
  saveEvidence,
  sqliteDb,
} from "../src/db";
import type { EvidenceMediaType } from "../src/db";
import { handleStatusRequest } from "../src/dashboard";
import {
  parseEvidenceListResponse,
  parseEvidenceMetadataResponse,
  type EvidenceListResponse,
  type IssueDetailResponse,
} from "../src/dashboard/src/contract";
import { createLiveStatusProvider } from "../src/dashboard/src/live/provider";
import { render, type RenderModel } from "../src/dashboard/src/client/render";
import {
  filterEvidence,
  mediaSummary,
  sizeLabel,
  timeLabel,
} from "../src/dashboard/src/client/evidence";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const VIDEO = "01JA0000000000000000000001";
const IMAGE = "01JA0000000000000000000002";
const OTHER_RUN = "01JA0000000000000000000003";
const HIDDEN = "01JA0000000000000000000004";

async function seeded() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item", title: "Checkout flow", sessionKey: "visible", now: 1 });
  insertQueuedItem(db, { id: "secret", title: "Secret project", sessionKey: "hidden", now: 2 });
  const run = await insertRun(sqliteDb(db), { itemId: "item", now: 10, agent: "claude" });
  const later = await insertRun(sqliteDb(db), { itemId: "item", now: 20, agent: "codex" });
  const hidden = await insertRun(sqliteDb(db), { itemId: "secret", now: 30, agent: "claude" });
  const save = async (
    id: string,
    itemId: string,
    runId: string,
    mediaType: EvidenceMediaType,
    displayName: string,
    createdAt: number,
  ) =>
    await saveEvidence(sqliteDb(db), {
      id,
      itemId,
      runId,
      checkId: "e2e",
      attempt: 2,
      mediaType,
      sizeBytes: 3 * 1024 * 1024,
      sha256: "f".repeat(64),
      displayName,
      headCommit: HEAD,
      createdAt,
    });
  await save(VIDEO, "item", run.id, "video/webm", "checkout.webm", 1_700_000_000_000);
  await save(IMAGE, "item", run.id, "image/png", "Cart <total>.png", 1_700_000_001_000);
  await save(OTHER_RUN, "item", later.id, "image/png", "later.png", 1_700_000_002_000);
  await save(HIDDEN, "secret", hidden.id, "image/png", "secret-file.png", 1_700_000_003_000);
  return { db, run, later, hidden };
}

async function galleryFor(
  db: Awaited<ReturnType<typeof seeded>>["db"],
): Promise<EvidenceListResponse> {
  const raw = await createLiveStatusProvider(sqliteDb(db), {
    sessionIds: ["visible"],
    now: () => new Date(1_700_000_010_000),
  }).evidence();
  const parsed = parseEvidenceListResponse(JSON.parse(JSON.stringify(raw)));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.response;
}

/** A run's issue page, rendered from that issue's detail as the dashboard loads it. */
async function runPage(
  db: Awaited<ReturnType<typeof seeded>>["db"],
  runId: string,
): Promise<string> {
  const provider = createLiveStatusProvider(sqliteDb(db), {
    sessionIds: ["visible"],
    now: () => new Date(1_700_000_010_000),
  });
  const itemId = (await provider.issues()).runs.find(
    (run) => run.id === runId || run.attempts?.includes(runId),
  )!.itemId;
  return page({ view: "issues", id: itemId }, await provider.issue(itemId));
}

async function evidencePage(
  db: Awaited<ReturnType<typeof seeded>>["db"],
  id: string,
): Promise<string> {
  const response = await createLiveStatusProvider(sqliteDb(db), {
    sessionIds: ["visible"],
    now: () => new Date(1_700_000_010_000),
  }).evidenceMetadata(id);
  const parsed = response === null ? null : parseEvidenceMetadataResponse(response);
  if (parsed !== null && !parsed.ok) throw new Error(parsed.error);
  return page({ view: "evidence", id }, null, {
    evidence: parsed === null ? null : parsed.response,
    missingEvidence: parsed === null ? id : null,
  });
}

function page(
  route: RenderModel["route"],
  detail: IssueDetailResponse | null = null,
  evidence: Pick<RenderModel, "evidence" | "missingEvidence"> = {},
): string {
  return render({
    route,
    phase: "ready",
    issue: detail,
    ...evidence,
    error: null,
    engineUrl: null,
    mediaInfo: new Map([
      [VIDEO, { durationMs: 83_000 }],
      [IMAGE, { width: 1280, height: 720 }],
    ]),
  }).content;
}

describe("live evidence", () => {
  test("the gallery lists only the evidence of items the reader can see", async () => {
    const { db, run, later } = await seeded();
    const gallery = await galleryFor(db);
    expect(gallery.evidence.map((entry) => [entry.id, entry.kind, entry.runId])).toEqual([
      [VIDEO, "video", run.id],
      [IMAGE, "image", run.id],
      [OTHER_RUN, "image", later.id],
    ]);
    const video = gallery.evidence[0]!;
    expect(video.publisher).toBe("Claude");
    expect(video.publishedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(JSON.stringify(gallery)).not.toContain("secret-file.png");
  });

  test("the run page has an Evidence slot only when the run has evidence", async () => {
    const { db, run, later } = await seeded();
    const gallery = await galleryFor(db);
    expect(await runPage(db, run.id)).toContain(
      `<div id="evidence-gallery" data-run="${run.id}"></div>`,
    );
    expect(filterEvidence(gallery.evidence, "video").map((entry) => entry.id)).toEqual([VIDEO]);
    expect(await runPage(db, later.id)).toContain("evidence-gallery");
    insertQueuedItem(db, { id: "bare-item", title: "No evidence", sessionKey: "visible", now: 3 });
    const bare = await insertRun(sqliteDb(db), { itemId: "bare-item", now: 40, agent: "claude" });
    expect(await runPage(db, bare.id)).not.toContain("evidence-gallery");
  });

  test("the evidence page shows the file details and the rest of the run", async () => {
    const { db } = await seeded();
    const html = await evidencePage(db, VIDEO);
    const item = (await galleryFor(db)).evidence[0]!.itemId;
    for (const text of [
      item,

      "checkout.webm",
      "e2e · attempt 2",

      "Claude",
      "3.0 MB",
      "1:23",

      HEAD.slice(0, 7),
      'data-action="evidence-copy"',
      `href="/api/evidence/${VIDEO}" download="checkout.webm">Download</a>`,
      `<div id="evidence-player" data-evidence="${VIDEO}"></div>`,
      'aria-label="More from this issue"',
      `href="/issues/${item}#check=2/e2e">Closeout output</a>`,
      `href="/evidence/${IMAGE}"`,
      'alt="Cart &lt;total&gt;.png"',
    ])
      expect(html).toContain(text);
    expect(html).toContain(OTHER_RUN);
    const image = await evidencePage(db, IMAGE);
    expect(image).toContain("1280×720");
  });

  test("evidence the reader cannot see shows the no-access state and nothing about it", async () => {
    const { db } = await seeded();
    for (const id of [HIDDEN, "01JAZZZZZZZZZZZZZZZZZZZZZZ"]) {
      const html = await evidencePage(db, id);
      expect(html).toContain("You don't have access to this evidence");
      for (const leak of ["secret", "Secret project", "secret-file.png", "evidence-player"])
        expect(html).not.toContain(leak);
    }
  });

  test("labels for size, duration and kind", () => {
    expect(sizeLabel(512)).toBe("512 B");
    expect(sizeLabel(1536)).toBe("1.5 KB");
    expect(sizeLabel(200 * 1024 * 1024)).toBe("200 MB");
    expect(timeLabel(9_400)).toBe("0:09");
    expect(timeLabel(3_725_000)).toBe("1:02:05");
    expect(mediaSummary("video", undefined)).toBe("Video");
    expect(mediaSummary("image", { width: 640, height: 480 })).toBe("Image · 640×480");
  });

  test("a bare evidence link redirects to the dashboard page", async () => {
    const response = await handleStatusRequest(
      new Request(`http://127.0.0.1:8787/evidence/${VIDEO}`),
      { staticDir: null },
    );
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe(`/dashboard/evidence/${VIDEO}`);
    expect(
      await handleStatusRequest(new Request("http://127.0.0.1:8787/evidence/../x"), {
        staticDir: null,
      }),
    ).toBeNull();
  });

  test("the contract rejects malformed evidence", async () => {
    const { db } = await seeded();
    const raw = JSON.parse(JSON.stringify(await galleryFor(db)));
    raw.evidence[0].kind = "audio";
    expect(parseEvidenceListResponse(raw).ok).toBe(false);
    raw.evidence[0].kind = "video";
    raw.evidence[0].attempt = 0;
    expect(parseEvidenceListResponse(raw).ok).toBe(false);
  });
});
