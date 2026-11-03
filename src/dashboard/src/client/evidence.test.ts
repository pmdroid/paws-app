import { expect, test } from "bun:test";
import type { EvidenceMetadataResponse, StatusEvidence } from "../contract";
import {
  closeoutOutputHref,
  evidencePageHref,
  renderEvidenceGallery,
  renderEvidencePage,
} from "./evidence";

const PROJECT = { name: "Paws", team: "PAS", repo: "pmdroid/paws-app", workspace: null };

function entry(id: string, kind: "image" | "video", itemId = "PAS-7"): StatusEvidence {
  return {
    id,
    itemId,
    runId: "run",
    checkId: "visual-proof",
    attempt: 2,
    kind,
    mediaType: kind === "video" ? "video/webm" : "image/png",
    displayName: `${id}.${kind === "video" ? "webm" : "png"}`,
    sizeBytes: 4096,
    headCommit: "a".repeat(40),
    publishedAt: "2026-11-01T10:00:00.000Z",
    publisher: "Claude",
  };
}

test("the gallery shows each file newest first with its issue and check, and loads media lazily", () => {
  const html = renderEvidenceGallery(
    {
      source: "live",
      generatedAt: "2026-11-02T00:00:00.000Z",
      project: PROJECT,
      evidence: [entry("first", "image"), entry("second", "video", "PAS-8")],
    },
    new Map(),
    null,
  );
  expect(html.indexOf(evidencePageHref("second"))).toBeLessThan(
    html.indexOf(evidencePageHref("first")),
  );
  expect(html).toContain(">PAS-7</a>");
  expect(html).toContain(">PAS-8</a>");
  expect(html).toContain(`href="${closeoutOutputHref(entry("first", "image"))}"`);
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('preload="metadata"');
  expect(html).not.toContain("<video controls");
});

test("an empty gallery says so", () => {
  const html = renderEvidenceGallery(
    { source: "live", generatedAt: "2026-11-02T00:00:00.000Z", project: PROJECT, evidence: [] },
    new Map(),
    null,
  );
  expect(html).toContain("No evidence");
});

test("the page names its issue, check and repository and lists the issue's other files", () => {
  const shown = entry("shown", "video");
  const page: EvidenceMetadataResponse = {
    source: "live",
    generatedAt: "2026-11-02T00:00:00.000Z",
    project: PROJECT,
    evidence: shown,
    related: [entry("before", "image"), shown],
  };
  const html = renderEvidencePage(page, new Map(), null);
  expect(html).toContain('id="evidence-player" data-evidence="shown"');
  expect(html).toContain("visual-proof · attempt 2");
  expect(html).toContain("pmdroid/paws-app");
  expect(html).toContain(`href="${evidencePageHref("before")}"`);
  expect(html).not.toContain(`href="${evidencePageHref("shown")}"`);
  expect(html).toContain('href="/api/evidence/shown" download="shown.webm"');
});

test("missing and forbidden evidence render the same page", () => {
  const html = renderEvidencePage(null, new Map(), null);
  expect(html).toContain("You don't have access to this evidence");
  expect(html).not.toContain("pmdroid/paws-app");
});
