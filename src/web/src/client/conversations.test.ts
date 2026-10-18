import { expect, test } from "bun:test";
import {
  canReadConversations,
  loadConversations,
  renderConversations,
  type ConversationModel,
} from "./conversations";
import { parseRoute, routeHref } from "./route";

test("private conversation requests stay on the selected same-origin local live engine", async () => {
  const requests: string[] = [];
  const request = async (url: URL) => {
    requests.push(String(url));
    return Response.json({ sessions: [] });
  };
  const origin = "http://127.0.0.1:8787";
  for (const [engine, source] of [
    ["https://remote.example", "live"],
    [origin, "demo"],
    ["http://127.0.0.1:8788", "live"],
    [null, "live"],
  ] as const) {
    expect(await loadConversations(engine, source, origin, request)).toEqual({
      state: "unavailable",
      sessions: [],
    });
  }
  expect(requests).toEqual([]);
  expect(await loadConversations(origin, "live", origin, request)).toEqual({
    state: "ready",
    sessions: [],
  });
  expect(requests).toEqual([`${origin}/api/linear/conversations`]);
  expect(canReadConversations("https://remote.example", "live", origin)).toBe(false);
  expect(
    await loadConversations(
      origin,
      "live",
      origin,
      async () => new Response(null, { status: 503 }),
    ),
  ).toEqual({ state: "error", sessions: [] });
});

test("conversation outcomes, queued prompts, publication failures and files remain usable", () => {
  const model: ConversationModel = {
    state: "ready",
    sessions: [
      {
        id: "session/thread",
        title: "Read the screenshot",
        stopped: false,
        activeItemId: "answer",
        summary: "Answer ready",
        planState: "pending",
        delivery: [{ id: 1, kind: "plan", state: "pending" }],
        items: [
          {
            id: "answer",
            identifier: "ENG-1",
            title: "Explain <chart>",
            state: "completed",
            mode: "answer",
            response: "42 rows",
          },
        ],
        messages: [
          { id: "first", at: 1000, kind: "prompt", text: "Use <annual>", state: "cancelled" },
          { id: "next", at: 2000, kind: "prompt", text: "Use monthly", state: "pending" },
          { id: "response", at: 3000, kind: "response", text: "42 rows", state: "dead" },
        ],
        plan: [{ content: "Inspect chart", status: "completed" }],
        questions: [],
        artifacts: [
          {
            id: "file",
            itemId: "answer",
            displayName: "Chart <1>.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            state: "failed",
            href: "/api/linear/artifacts/file",
          },
        ],
        links: [{ label: "Open in Linear", href: "https://linear.app/acme/issue/ENG-1" }],
      },
    ],
  };
  const html = renderConversations(model, "session/thread");
  expect(html).toContain('<span class="lin-id">ENG-1</span> <span>Explain &lt;chart&gt;</span>');
  expect(html).toContain('<span class="muted">image/png · 2 KB</span>');
  expect(html).toContain("Completed");
  expect(html).not.toContain("Merged");
  expect(html).toContain("Interrupted");
  expect(html).toContain("Queued prompt");
  expect(html).toContain("Delivery failed");
  expect(html).toContain("Publication retry needed");
  expect(html).toContain('src="/api/linear/artifacts/file"');
  expect(html).toContain('href="/api/linear/artifacts/file?download=1"');
  expect(html).toContain("Chart &lt;1&gt;.png");
  expect(html).not.toContain("Use <annual>");
  expect(parseRoute("/sessions/session%2Fthread")).toEqual({
    view: "sessions",
    id: "session/thread",
  });
  expect(routeHref({ view: "sessions", id: "session/thread" })).toBe("/sessions/session%2Fthread");
  model.sessions[0]!.questions.push({
    id: "question",
    itemId: "answer",
    body: "Which total?",
    options: [{ label: "Annual", value: "year" }],
    state: "open",
    answer: null,
    createdAt: 4,
  });
  const waiting = renderConversations(model, null);
  expect(waiting).toContain("Awaiting input");
  expect(waiting).toContain("Annual");
  expect(waiting).toContain("Answer in Linear");
});
