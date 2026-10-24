import { describe, expect, test } from "bun:test";
import { insertQueuedItem, insertRun, migrate, openDatabase, saveEvidence } from "../src/db";
import type { EvidenceMediaType } from "../src/db";
import { handleStatusRequest } from "../src/web";
import { parseStatusSnapshot, type StatusSnapshot } from "../src/web/src/contract";
import { createLiveStatusProvider } from "../src/web/src/live/provider";
import { render, type RenderModel } from "../src/web/src/client/render";
import { filterEvidence, mediaSummary, sizeLabel, timeLabel } from "../src/web/src/client/evidence";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const VIDEO = "01JA0000000000000000000001";
const IMAGE = "01JA0000000000000000000002";
const OTHER_RUN = "01JA0000000000000000000003";
const HIDDEN = "01JA0000000000000000000004";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item", title: "Checkout flow", sessionKey: "visible", now: 1 });
  insertQueuedItem(db, { id: "secret", title: "Secret project", sessionKey: "hidden", now: 2 });
  const run = insertRun(db, { itemId: "item", now: 10, agent: "claude" });
  const later = insertRun(db, { itemId: "item", now: 20, agent: "codex" });
  const hidden = insertRun(db, { itemId: "secret", now: 30, agent: "claude" });
  const save = (
    id: string,
    itemId: string,
    runId: string,
    mediaType: EvidenceMediaType,
    displayName: string,
    createdAt: number,
  ) =>
    saveEvidence(db, {
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
  save(VIDEO, "item", run.id, "video/webm", "checkout.webm", 1_700_000_000_000);
  save(IMAGE, "item", run.id, "image/png", "Cart <total>.png", 1_700_000_001_000);
  save(OTHER_RUN, "item", later.id, "image/png", "later.png", 1_700_000_002_000);
  save(HIDDEN, "secret", hidden.id, "image/png", "secret-file.png", 1_700_000_003_000);
  return { db, run, later, hidden };
}

function snapshotFor(db: ReturnType<typeof seeded>["db"]): StatusSnapshot {
  const raw = createLiveStatusProvider(db, {
    sessionIds: ["visible"],
    now: () => new Date(1_700_000_010_000),
  }).snapshot();
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(raw)));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.snapshot;
}

function page(snapshot: StatusSnapshot, route: RenderModel["route"]): string {
  return render({
    route,
    phase: "ready",
    snapshot,
    via: "engine",
    error: null,
    engineUrl: null,
    mediaInfo: new Map([
      [VIDEO, { durationMs: 83_000 }],
      [IMAGE, { width: 1280, height: 720 }],
    ]),
  }).content;
}

describe("live evidence", () => {
  test("the snapshot lists only the evidence of items the reader can see", () => {
    const { db, run, later } = seeded();
    const snapshot = snapshotFor(db);
    expect(snapshot.evidence?.map((entry) => [entry.id, entry.kind, entry.runId])).toEqual([
      [VIDEO, "video", run.id],
      [IMAGE, "image", run.id],
      [OTHER_RUN, "image", later.id],
    ]);
    const video = snapshot.evidence![0]!;
    expect(video.publisher).toBe("Claude");
    expect(video.publishedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(JSON.stringify(snapshot)).not.toContain("secret-file.png");
  });

  test("the run page has an Evidence slot only when the run has evidence", () => {
    const { db, run, later } = seeded();
    const snapshot = snapshotFor(db);
    expect(page(snapshot, { view: "runs", id: run.id })).toContain(
      `<div id="evidence-gallery" data-run="${run.id}"></div>`,
    );
    expect(filterEvidence(snapshot.evidence!, "video").map((entry) => entry.id)).toEqual([VIDEO]);
    insertQueuedItem(db, { id: "bare-item", title: "No evidence", sessionKey: "visible", now: 3 });
    const bare = insertRun(db, { itemId: "bare-item", now: 40, agent: "claude" });
    const html = page(snapshotFor(db), { view: "runs", id: bare.id });
    expect(html).not.toContain("evidence-gallery");
    expect(page(snapshot, { view: "runs", id: later.id })).toContain("evidence-gallery");
  });

  test("the evidence page shows the file details and the rest of the run", () => {
    const { db } = seeded();
    const snapshot = snapshotFor(db);
    const html = page(snapshot, { view: "evidence", id: VIDEO });
    const item = snapshot.evidence![0]!.itemId;
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
    const image = page(snapshot, { view: "evidence", id: IMAGE });
    expect(image).toContain("1280×720");
  });

  test("evidence the reader cannot see shows the no-access state and nothing about it", () => {
    const { db } = seeded();
    const snapshot = snapshotFor(db);
    for (const id of [HIDDEN, "01JAZZZZZZZZZZZZZZZZZZZZZZ"]) {
      const html = page(snapshot, { view: "evidence", id });
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
    expect(response?.headers.get("location")).toBe(`/status/evidence/${VIDEO}`);
    expect(
      await handleStatusRequest(new Request("http://127.0.0.1:8787/evidence/../x"), {
        staticDir: null,
      }),
    ).toBeNull();
  });

  test("the contract rejects malformed evidence", () => {
    const { db } = seeded();
    const raw = JSON.parse(JSON.stringify(snapshotFor(db)));
    raw.evidence[0].kind = "audio";
    expect(parseStatusSnapshot(raw).ok).toBe(false);
    raw.evidence[0].kind = "video";
    raw.evidence[0].attempt = 0;
    expect(parseStatusSnapshot(raw).ok).toBe(false);
  });
});
