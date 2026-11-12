import { describe, expect, test } from "bun:test";
import { GENERATED_AT_HEADER, type QuestionListResponse } from "../contract";
import { questionCardFixture as card } from "../../test/fixtures";
import { createPageLoader } from "./page-loader";
import { createResourceReader } from "./resource-reader";
import { renderQuestions, type QuestionsView } from "./questions";

const AT = "2026-11-02T09:00:00.000Z";

type Sent = { path: string; match: string | null; answer(response: Response): void };

function loader(reader = { id: "member-a" }) {
  const sent: Sent[] = [];
  const pages = createPageLoader({
    reader: () => reader.id,
    signedIn: async () => true,
    resources: createResourceReader(
      (path, init) =>
        new Promise<Response>((resolve) => {
          sent.push({
            path,
            match: new Headers(init.headers).get("If-None-Match"),
            answer: resolve,
          });
        }),
    ),
  });
  return { pages, sent, reader };
}

const list = (...ids: string[]): QuestionListResponse => ({
  source: "live",
  generatedAt: AT,
  questions: ids.map((id) => card(id)),
});
const detail = (id: string) =>
  Response.json(
    { source: "live", generatedAt: AT, question: card(id) },
    { headers: { ETag: `W/"${id}"` } },
  );
const listed = (...ids: string[]) => Response.json(list(...ids), { headers: { ETag: 'W/"list"' } });
const status = (code: number) => Response.json({ error: "Not found" }, { status: code });

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

describe("question page loading", () => {
  test("the list and a selected question read only their own resources", async () => {
    const { pages, sent } = loader();
    const all = pages.load({ view: "questions", id: null });
    await settle();
    sent[0]!.answer(listed("q-1"));
    expect(await all).toBe("applied");
    pages.navigate();
    const one = pages.load({ view: "questions", id: "q-1" });
    await settle();
    sent[1]!.answer(detail("q-1"));
    expect(await one).toBe("applied");
    expect(sent.map((entry) => entry.path)).toEqual(["/api/questions", "/api/questions/q-1"]);
    expect(pages.data.question?.question.id).toBe("q-1");
  });

  test("late success, error and 404 for the question left behind are dropped", async () => {
    const { pages, sent } = loader();
    const left = [
      pages.load({ view: "questions", id: "q-1" }),
      pages.load({ view: "questions", id: "q-1" }),
      pages.load({ view: "questions", id: "q-1" }),
    ];
    await settle();
    pages.navigate();
    const shown = pages.load({ view: "questions", id: "q-2" });
    await settle();
    sent[3]!.answer(detail("q-2"));
    expect(await shown).toBe("applied");
    sent[0]!.answer(detail("q-1"));
    sent[1]!.answer(status(500));
    sent[2]!.answer(status(404));
    expect(await Promise.all(left)).toEqual(["stale", "stale", "stale"]);
    expect(pages.data.question?.question.id).toBe("q-2");
    expect(pages.data.missingQuestion).toBeNull();
  });

  test("a 404 marks the question missing; a body for another question is refused", async () => {
    const { pages, sent } = loader();
    const gone = pages.load({ view: "questions", id: "q-9" });
    await settle();
    sent[0]!.answer(status(404));
    expect(await gone).toBe("applied");
    expect(pages.data.missingQuestion).toBe("q-9");
    const wrong = pages.load({ view: "questions", id: "q-1" });
    await settle();
    sent[1]!.answer(detail("q-2"));
    expect(await wrong).toEqual({ error: "The engine returned another question" });
  });

  test("a reader change drops the old reader's response and its ETag", async () => {
    const { pages, sent, reader } = loader();
    const first = pages.load({ view: "questions", id: null });
    await settle();
    sent[0]!.answer(listed("q-1"));
    await first;
    const late = pages.load({ view: "questions", id: null });
    await settle();
    expect(sent[1]!.match).toBe('W/"list"');
    reader.id = "member-b";
    pages.reset();
    expect(pages.data.questions).toBeNull();
    sent[1]!.answer(listed("q-1", "q-secret"));
    expect(await late).toBe("stale");
    const fresh = pages.load({ view: "questions", id: null });
    await settle();
    expect(sent[2]!.match).toBeNull();
    sent[2]!.answer(listed("q-2"));
    await fresh;
    expect(pages.data.questions?.questions.map((question) => question.id)).toEqual(["q-2"]);
  });

  test("a 304 keeps the list and takes the new generatedAt", async () => {
    const { pages, sent } = loader();
    const first = pages.load({ view: "questions", id: null });
    await settle();
    sent[0]!.answer(listed("q-1"));
    await first;
    const later = "2026-11-02T09:00:05.000Z";
    const again = pages.load({ view: "questions", id: null });
    await settle();
    sent[1]!.answer(new Response(null, { status: 304, headers: { [GENERATED_AT_HEADER]: later } }));
    await again;
    expect(pages.data.questions?.generatedAt).toBe(later);
    expect(pages.data.questions?.questions[0]?.id).toBe("q-1");
  });
});

describe("question cards", () => {
  const view = (patch: Partial<QuestionsView>): QuestionsView => ({
    selected: null,
    list: null,
    detail: null,
    missing: false,
    error: null,
    ...patch,
  });

  test("a card names its issue and agent from the resource and keeps its Linear links", () => {
    const html = renderQuestions(view({ list: list("q-1") }));
    expect(html).toContain(
      '<span class="st awaiting_input">Question</span><a class="lin-id" href="/issues/PAS-1">PAS-1</a><span class="min-w-0">Ship it</span>',
    );
    expect(html).toContain('<span class="mono dim">claude · 1h ago</span>');
    expect(html).toContain("Oldest first. An answered question leaves this list.");
    expect(html).toContain('href="https://linear.app/paws/issue/PAS-1"');
    expect(html).not.toContain(" hl");
  });

  test("a review rounds link ask shows its kind and opens its decision card", () => {
    const ask = card("q-1");
    ask.linkAsk = {
      kind: "rounds",
      head: "b".repeat(40),
      title: "Three review rounds found more.",
      detail: "",
      link: "https://paws.example/dashboard/issues/PAS-1#review-rounds",
    };
    const html = renderQuestions(view({ list: { ...list(), questions: [ask] } }));
    expect(html).toContain('<span class="st awaiting_input">Review rounds</span>');
    expect(html).toContain('<a class="lin-id" href="/issues/PAS-1">PAS-1</a>');
    expect(html).toContain('href="/issues/PAS-1#review-rounds"');
  });

  test("a link ask card opens its decision card on the issue page", () => {
    const ask = card("q-1");
    ask.linkAsk = {
      kind: "risk",
      head: "a".repeat(40),
      title: "High-risk paths changed.",
      detail: "",
      link: "https://paws.example/dashboard/issues/PAS-1#risk",
    };
    const html = renderQuestions(view({ list: { ...list(), questions: [ask] } }));
    expect(html).toContain('href="/issues/PAS-1#risk"');
    expect(html).toContain("Review risk");
  });

  test("the selected, missing, loading, empty and failed states", () => {
    const one = { source: "live" as const, generatedAt: AT, question: card("q-1") };
    const html = renderQuestions(view({ selected: "q-1", detail: one }));
    expect(html).toContain('class="q hl"');
    expect(html).toContain('href="/questions"');
    expect(renderQuestions(view({ selected: "q-1", missing: true }))).toContain(
      "This question is answered",
    );
    expect(renderQuestions(view({ selected: "q-1" }))).toContain("Loading questions");
    const empty = renderQuestions(view({ list: list() }));
    expect(empty).toContain(
      "No open questions. Paws asks here when the agent or Closeout needs a person, such as a spent fix budget or a bypass.",
    );
    expect(empty).not.toContain("Oldest first");
    expect(renderQuestions(view({ error: "Engine responded 500" }))).toContain(
      "Questions unavailable",
    );
  });
});
