import type { Database } from "bun:sqlite";
import {
  getLinearConversationSource,
  listLinearConversationSnapshots,
  listLinearSessionArtifacts,
  listLinearSessionQuestions,
  listLinearSessionTasks,
  listLinearSessionTurns,
  listLinearSessions,
  listOutbox,
  type LinearConversationSession,
} from "../../../db";

export type ConversationMessage = {
  id: string;
  at: number;
  kind: string;
  text: string;
  state: string;
};

export function readLinearConversations(db: Database, sessionIds?: readonly string[]) {
  return listLinearSessions(db)
    .filter((session) => sessionIds === undefined || sessionIds.includes(session.id))
    .map((session) => readConversation(db, session));
}

function readConversation(db: Database, session: LinearConversationSession) {
  const messages = new Map<string, ConversationMessage>();
  for (const raw of listLinearConversationSnapshots(db, session.id)) {
    const snapshot = object(raw);
    const content = object(snapshot["content"]);
    const id = text(snapshot["id"]);
    if (!id || snapshot["ephemeral"] === true) continue;
    messages.set(id, {
      id,
      at: Date.parse(text(snapshot["createdAt"])) || 0,
      kind: text(content["type"]),
      text: contentText(content),
      state: "sent",
    });
  }
  for (const turn of listLinearSessionTurns(db, session.id)) {
    const id = turn.activityId ?? turn.id;
    messages.set(id, {
      id,
      at: turn.createdAt,
      kind: "prompt",
      text: safeText(turn.body),
      state: turn.state,
    });
  }
  const rows = listOutbox(db, session.id).filter((row) => row.target === "linear");
  for (const row of rows) {
    if (row.op !== "activity" && row.op !== "elicitation") continue;
    const payload = object(row.payload);
    if (payload["ephemeral"] === true) continue;
    const id = text(payload["id"]) || `outbox:${row.id}`;
    if (messages.has(id) && row.status === "sent") continue;
    messages.set(id, {
      id,
      at: row.createdAt,
      kind: row.op === "elicitation" ? "elicitation" : text(payload["kind"]),
      text: contentText(payload),
      state: row.status,
    });
  }
  const metadata = rows.filter(
    (row) => row.status !== "dropped" && row.generation === session.generation,
  );
  const planRow = metadata.findLast((row) => row.op === "linear.session.plan");
  const summaryRow = metadata.findLast((row) => row.op === "linear.session.summary");
  const plan = object(planRow?.payload)["plan"];
  const links = new Map<string, { label: string; href: string }>();
  const source = safeLink(getLinearConversationSource(db, session.id));
  for (const row of rows.filter((entry) => entry.status !== "dropped")) {
    const payload = object(row.payload);
    const replacement = payload["externalUrls"];
    const removed = payload["removedExternalUrls"];
    if (Array.isArray(replacement)) links.clear();
    if (Array.isArray(removed))
      for (const raw of removed) {
        const href = safeLink(raw);
        if (href) links.delete(href);
      }
    const additions = Array.isArray(replacement) ? replacement : payload["addedExternalUrls"];
    if (!Array.isArray(additions)) continue;
    for (const raw of additions) {
      const link = object(raw);
      const href = safeLink(link["url"]);
      if (href) links.set(href, { label: text(link["label"]) || href, href });
    }
  }
  if (source) links.set(source, { label: "Linear session", href: source });
  const items = listLinearSessionTasks(db, session.id).map((item) => ({
    ...item,
    title: safeText(item.title),
    response: item.response === null ? null : safeText(item.response),
  }));
  return {
    id: session.id,
    title:
      items.find((item) => item.id === session.activeItemId)?.title ??
      items[0]?.title ??
      "Linear session",
    stopped: session.stoppedAt !== null,
    activeItemId: session.activeItemId,
    summary: safeText(text(object(summaryRow?.payload)["summary"])),
    planState: planRow?.status ?? null,
    delivery: metadata
      .filter((row) => row.op.startsWith("linear.session."))
      .map((row) => ({
        id: row.id,
        kind: row.op.slice("linear.session.".length),
        state: row.status,
      })),
    items,
    messages: [...messages.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    plan: Array.isArray(plan)
      ? plan.flatMap((entry) => {
          const step = object(entry);
          return typeof step["content"] === "string" &&
            ["pending", "inProgress", "completed", "canceled"].includes(text(step["status"]))
            ? [{ content: safeText(step["content"]), status: text(step["status"]) }]
            : [];
        })
      : [],
    questions: listLinearSessionQuestions(db, session.id).map((question) => ({
      ...question,
      body: safeText(question.body),
      answer: question.answer === null ? null : safeText(question.answer),
      options: question.options.map((option) =>
        typeof option === "string"
          ? safeText(option)
          : {
              value: safeText(option.value),
              ...(option.label === undefined ? {} : { label: safeText(option.label) }),
            },
      ),
    })),
    artifacts: listLinearSessionArtifacts(db, session.id).map((artifact) => ({
      ...artifact,
      href: `/api/linear/artifacts/${encodeURIComponent(artifact.id)}`,
    })),
    links: [...links.values()],
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(content: Record<string, unknown>): string {
  const action = object(content["action"]);
  return safeText(
    text(content["body"]) ||
      [
        text(action["action"] ?? content["action"]),
        text(action["parameter"] ?? content["parameter"]),
        text(action["result"] ?? content["result"]),
      ]
        .filter(Boolean)
        .join(" "),
  );
}

function safeText(value: string): string {
  return value.replace(/https:\/\/uploads\.linear\.app\/[^\s<>"'`]+/g, (match) => {
    try {
      const url = new URL(match);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "Linear file";
    }
  });
}

function safeLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" && ["linear.app", "github.com"].includes(url.hostname))
      return url.href;
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return url.href;
    return null;
  } catch {
    return null;
  }
}
