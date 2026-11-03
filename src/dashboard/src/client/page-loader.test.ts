import { describe, expect, test } from "bun:test";
import { GENERATED_AT_HEADER } from "../contract";
import { fullStatusFixture, issueList, issueResource } from "../../test/fixtures";
import { createPageLoader } from "./page-loader";
import { createResourceReader } from "./resource-reader";
import { emptyOverview } from "../live/overview";

type Sent = { path: string; match: string | null; answer(response: Response): void };

function fakeServer() {
  const sent: Sent[] = [];
  const fetcher = (path: string, init: RequestInit) =>
    new Promise<Response>((resolve) => {
      sent.push({ path, match: new Headers(init.headers).get("If-None-Match"), answer: resolve });
    });
  return { sent, fetcher };
}

const full = fullStatusFixture();
const detail = (id: string, etag = `W/"${id}"`) =>
  Response.json(issueResource(full, id), { headers: { ETag: etag } });
const list = () => Response.json(issueList(full), { headers: { ETag: 'W/"list"' } });
const missing = () => Response.json({ error: "Not found" }, { status: 404 });

function loader(reader = { id: "member-a" }, signedIn = async () => true) {
  const server = fakeServer();
  const pages = createPageLoader({
    reader: () => reader.id,
    signedIn,
    resources: createResourceReader(server.fetcher),
  });
  return { ...server, pages, reader };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

describe("issue page loading", () => {
  test("the issue list and an issue page read their own resources, never /api/status", async () => {
    const { pages, sent } = loader();
    const listed = pages.load({ view: "issues", id: null });
    await settle();
    sent[0]!.answer(list());
    expect(await listed).toBe("applied");
    const opened = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[1]!.answer(detail("ENG-101"));
    expect(await opened).toBe("applied");
    const run = pages.load({ view: "runs", id: "r-101" });
    await settle();
    sent[2]!.answer(list());
    await run;
    expect(sent.map((entry) => entry.path)).toEqual([
      "/api/issues",
      "/api/issues/ENG-101",
      "/api/issues",
    ]);
    expect(pages.data.issue?.issue.id).toBe("ENG-101");
    expect(pages.data.snapshot).toBeNull();
  });

  test("a delayed 404 for the issue left behind does not clear the newly selected issue", async () => {
    const { pages, sent } = loader();
    const first = pages.load({ view: "issues", id: "ENG-999" });
    await settle();
    pages.navigate();
    const second = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[1]!.answer(detail("ENG-101"));
    expect(await second).toBe("applied");
    sent[0]!.answer(missing());
    expect(await first).toBe("stale");
    expect(pages.data.issue?.issue.id).toBe("ENG-101");
    expect(sent.map((entry) => entry.path)).toEqual(["/api/issues/ENG-999", "/api/issues/ENG-101"]);
  });

  test("an unknown issue loads the list for the not-found page and clears the old detail", async () => {
    const { pages, sent } = loader();
    const opened = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[0]!.answer(detail("ENG-101"));
    await opened;
    pages.navigate();
    const unknown = pages.load({ view: "issues", id: "ENG-999" });
    await settle();
    sent[1]!.answer(missing());
    await settle();
    sent[2]!.answer(list());
    expect(await unknown).toBe("applied");
    expect(pages.data.issue).toBeNull();
    expect(pages.data.issues?.issues.length).toBeGreaterThan(0);
  });

  test("of overlapping requests for the same issue, an older one finishing last is ignored", async () => {
    const { pages, sent } = loader();
    const poll = pages.load({ view: "issues", id: "ENG-101" });
    const afterAction = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    const newer = issueResource(full, "ENG-101");
    newer.issue.title = "After the action";
    sent[1]!.answer(Response.json(newer, { headers: { ETag: 'W/"newer"' } }));
    expect(await afterAction).toBe("applied");
    sent[0]!.answer(detail("ENG-101"));
    expect(await poll).toBe("stale");
    expect(pages.data.issue?.issue.title).toBe("After the action");
  });

  test("an error that arrives after navigation is not shown on the next page", async () => {
    const { pages, sent } = loader();
    const first = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    pages.navigate();
    const second = pages.load({ view: "issues", id: null });
    await settle();
    sent[0]!.answer(Response.json({ error: "boom" }, { status: 500 }));
    expect(await first).toBe("stale");
    sent[1]!.answer(list());
    expect(await second).toBe("applied");
  });

  test("a response for the previous reader is dropped and a reset forgets its data", async () => {
    const { pages, sent, reader } = loader();
    const opened = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[0]!.answer(detail("ENG-101"));
    await opened;
    const late = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    reader.id = "member-b";
    pages.reset();
    expect(pages.data.issue).toBeNull();
    sent[1]!.answer(detail("ENG-101"));
    expect(await late).toBe("stale");
    expect(pages.data.issue).toBeNull();
    const again = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    expect(sent[2]!.match).toBeNull();
    sent[2]!.answer(detail("ENG-101"));
    expect(await again).toBe("applied");
  });

  test("the overview reads its own resource and drops a response that lands on another page", async () => {
    const { pages, sent } = loader();
    const late = pages.load({ view: "overview" });
    await settle();
    pages.navigate();
    const opened = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[0]!.answer(Response.json(emptyOverview(), { headers: { ETag: 'W/"o"' } }));
    expect(await late).toBe("stale");
    sent[1]!.answer(detail("ENG-101"));
    expect(await opened).toBe("applied");
    expect(sent.map((entry) => entry.path)).toEqual(["/api/overview", "/api/issues/ENG-101"]);
    expect(pages.data.overview).toBeNull();
  });

  test("a signed-out reader gets no data and no error", async () => {
    const { pages, sent } = loader({ id: "member-a" }, async () => false);
    const opened = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[0]!.answer(Response.json({ error: "Sign in" }, { status: 401 }));
    expect(await opened).toBe("signed-out");
    expect(pages.data.issue).toBeNull();
  });

  test("a 304 keeps the issue and takes the newer Paws-Generated-At", async () => {
    const { pages, sent } = loader();
    const opened = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    sent[0]!.answer(detail("ENG-101", 'W/"v1"'));
    await opened;
    const polled = pages.load({ view: "issues", id: "ENG-101" });
    await settle();
    expect(sent[1]!.match).toBe('W/"v1"');
    sent[1]!.answer(
      new Response(null, {
        status: 304,
        headers: { ETag: 'W/"v1"', [GENERATED_AT_HEADER]: "2026-11-02T10:00:05.000Z" },
      }),
    );
    expect(await polled).toBe("applied");
    expect(pages.data.issue?.issue.id).toBe("ENG-101");
    expect(pages.data.issue?.generatedAt).toBe("2026-11-02T10:00:05.000Z");
  });
});

describe("resource reader", () => {
  test("keeps ETags per resource and reader, and forgets them on clear", async () => {
    const sent: { path: string; match: string | null }[] = [];
    const read = createResourceReader(async (path, init) => {
      sent.push({ path, match: new Headers(init.headers).get("If-None-Match") });
      return Response.json(
        { generatedAt: "2026-11-02T10:00:00.000Z" },
        { headers: { ETag: 'W/"e"' } },
      );
    });
    const parse = (input: unknown) => ({
      ok: true as const,
      body: input as { generatedAt: string },
    });
    await read.read("/api/issues/ENG-1", "a", parse);
    await read.read("/api/issues/ENG-1", "a", parse);
    await read.read("/api/issues/ENG-1", "b", parse);
    await read.read("/api/issues/ENG-2", "a", parse);
    read.clear();
    await read.read("/api/issues/ENG-1", "a", parse);
    expect(sent.map((entry) => entry.match)).toEqual([null, 'W/"e"', null, null, null]);
  });

  test("a request that started before a clear does not keep its body", async () => {
    let answer: (response: Response) => void = () => {};
    const sent: (string | null)[] = [];
    const read = createResourceReader((_path, init) => {
      sent.push(new Headers(init.headers).get("If-None-Match"));
      return new Promise<Response>((resolve) => (answer = resolve));
    });
    const parse = (input: unknown) => ({
      ok: true as const,
      body: input as { generatedAt: string },
    });
    const pending = read.read("/api/issues", "a", parse);
    await settle();
    read.clear();
    answer(
      Response.json({ generatedAt: "2026-11-02T10:00:00.000Z" }, { headers: { ETag: 'W/"x"' } }),
    );
    await pending;
    const next = read.read("/api/issues", "a", parse);
    await settle();
    answer(Response.json({ generatedAt: "2026-11-02T10:00:00.000Z" }));
    await next;
    expect(sent).toEqual([null, null]);
  });
});

describe("evidence page loading", () => {
  const project = { name: "Paws", team: "ENG", repo: "acme/app", workspace: null };
  const file = (id: string) => ({
    id,
    itemId: "ENG-101",
    runId: "r-101",
    checkId: "visual-proof",
    attempt: 1,
    kind: "image" as const,
    mediaType: "image/png",
    displayName: `${id}.png`,
    sizeBytes: 2048,
    headCommit: "a".repeat(40),
    publishedAt: "2026-11-02T10:00:00.000Z",
    publisher: "Claude",
  });
  const generatedAt = "2026-11-03T00:00:00.000Z";
  const gallery = () =>
    Response.json(
      { source: "live", generatedAt, project, evidence: [file("01JA0000000000000000000001")] },
      { headers: { ETag: 'W/"gallery"' } },
    );
  const metadata = (id: string) =>
    Response.json(
      { source: "live", generatedAt, project, evidence: file(id), related: [file(id)] },
      { headers: { ETag: `W/"${id}"` } },
    );
  const first = "01JA0000000000000000000001";
  const second = "01JA0000000000000000000002";

  test("the gallery and one file read their own resources, never /api/status", async () => {
    const { pages, sent } = loader();
    const listed = pages.load({ view: "evidence", id: null });
    await settle();
    sent[0]!.answer(gallery());
    expect(await listed).toBe("applied");
    const opened = pages.load({ view: "evidence", id: first });
    await settle();
    sent[1]!.answer(metadata(first));
    expect(await opened).toBe("applied");
    expect(sent.map((entry) => entry.path)).toEqual([
      "/api/evidence",
      `/api/evidence/${first}/metadata`,
    ]);
    expect(pages.data.evidenceList?.evidence.map((entry) => entry.id)).toEqual([first]);
    expect(pages.data.evidence?.evidence.id).toBe(first);
    expect(pages.data.snapshot).toBeNull();
  });

  test("an unknown or hidden file is remembered as missing, and a late answer for the page left behind is dropped", async () => {
    const { pages, sent } = loader();
    const left = pages.load({ view: "evidence", id: first });
    await settle();
    pages.navigate();
    const opened = pages.load({ view: "evidence", id: second });
    await settle();
    sent[1]!.answer(missing());
    expect(await opened).toBe("applied");
    expect(pages.data.missingEvidence).toBe(second);
    expect(pages.data.evidence).toBeNull();
    sent[0]!.answer(metadata(first));
    expect(await left).toBe("stale");
    expect(pages.data.evidence).toBeNull();
    expect(pages.data.missingEvidence).toBe(second);
  });

  test("signing in as another reader clears loaded evidence", async () => {
    const { pages, sent } = loader();
    const opened = pages.load({ view: "evidence", id: first });
    await settle();
    sent[0]!.answer(metadata(first));
    expect(await opened).toBe("applied");
    pages.reset();
    expect(pages.data.evidence).toBeNull();
    expect(pages.data.evidenceList).toBeNull();
    expect(pages.data.missingEvidence).toBeNull();
  });
});
