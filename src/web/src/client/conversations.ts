import { routeHref } from "./route";
import type { readLinearConversations } from "../live/conversations";
import { esc } from "./format";

type Session = ReturnType<typeof readLinearConversations>[number];
export type ConversationModel = {
  state: "loading" | "unavailable" | "error" | "ready";
  sessions: Session[];
};

export function canReadConversations(
  engineUrl: string | null,
  source: string | undefined,
  origin: string,
): boolean {
  if (engineUrl === null || source !== "live") return false;
  try {
    return new URL(engineUrl).origin === origin;
  } catch {
    return false;
  }
}

export async function loadConversations(
  engineUrl: string | null,
  source: string | undefined,
  origin: string,
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<ConversationModel> {
  if (!canReadConversations(engineUrl, source, origin))
    return { state: "unavailable", sessions: [] };
  try {
    const response = await request(new URL("/api/linear/conversations", origin), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Conversation request failed");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("sessions" in body) || !Array.isArray(body.sessions))
      throw new Error("Invalid conversation response");
    return { state: "ready", sessions: body.sessions as Session[] };
  } catch {
    return { state: "error", sessions: [] };
  }
}

export function renderConversations(
  model: ConversationModel | undefined,
  id: string | null,
): string {
  const heading = '<h1 class="sr-only">Conversations</h1>';
  if (!model || model.state === "loading")
    return `${heading}<div class="empty" role="status">Loading Linear conversations…</div>`;
  if (model.state === "unavailable")
    return `${heading}<div class="empty">Open this Paws dashboard to read its Linear conversations.</div>`;
  if (model.state === "error")
    return `${heading}<div class="empty" role="alert">Could not load Linear conversations. <button class="btn" type="button" data-action="refresh">Retry</button></div>`;
  const selected =
    model.sessions.find((session) => session.id === id) ??
    (id === null ? model.sessions[0] : undefined);
  if (!selected)
    return `${heading}<div class="empty">${id ? `Conversation not found. <a href="${routeHref({ view: "sessions", id: null })}">View conversations</a>.` : "Delegate an issue to Paws or start a Linear session to see its conversation here."}</div>`;
  const current =
    selected.items.find((item) => item.id === selected.activeItemId) ?? selected.items.at(-1);
  const questions = selected.questions.filter((question) => question.state === "open");
  const status = selected.stopped
    ? "Stopped"
    : questions.length
      ? "Awaiting input"
      : current
        ? taskState(current.state)
        : "Starting";
  const picker = `<label class="entity-picker"><span>Conversation</span><select data-route-picker aria-label="Conversation">${model.sessions.map((session) => `<option value="${routeHref({ view: "sessions", id: session.id })}"${session.id === selected.id ? " selected" : ""}>${esc(session.title)}</option>`).join("")}</select></label>`;
  const links = selected.links
    .map(
      (link) =>
        `<a href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`,
    )
    .join(" ");
  const timeline = selected.messages
    .map(
      (message) =>
        `<li class="conversation-message${message.kind === "prompt" ? " conversation-prompt" : ""}"><div class="conversation-message-meta"><b>${message.kind === "prompt" ? "User" : "Paws"}</b><span>${esc(message.kind)}</span><time datetime="${new Date(message.at).toISOString()}">${esc(new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time>${deliveryBadge(message.state, message.kind)}</div><p>${esc(message.text)}</p></li>`,
    )
    .join("");
  const plan = selected.plan
    .map(
      (step) =>
        `<li class="conversation-row"><span>${esc(step.content)}</span><small class="muted">${esc(planState(step.status))}</small></li>`,
    )
    .join("");
  const files = selected.artifacts
    .map(
      (file) =>
        `<li class="conversation-row"><a href="${esc(file.href)}" target="_blank" rel="noopener noreferrer">${esc(file.displayName)}</a>${["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimeType) ? `<a href="${esc(file.href)}" target="_blank" rel="noopener noreferrer"><img src="${esc(file.href)}" alt="${esc(file.displayName)}" loading="lazy" /></a>` : ""}<span class="muted">${esc(file.mimeType)} · ${Math.ceil(file.sizeBytes / 1024)} KB</span><div class="row"><small>${file.state === "uploaded" ? "Published in Linear" : file.state === "failed" ? "Publication retry needed" : "Publishing to Linear"}</small><a href="${esc(file.href)}?download=1" download>Download</a></div></li>`,
    )
    .join("");
  const waiting = questions
    .map(
      (question) =>
        `<section class="conversation-question"><h2>${esc(question.body)}</h2>${question.options.length ? `<ul>${question.options.map((option) => `<li>${esc(typeof option === "string" ? option : (option.label ?? option.value))}</li>`).join("")}</ul>` : ""}<p>Answer in Linear to continue.</p></section>`,
    )
    .join("");
  const history = selected.items
    .map(
      (item) =>
        `<li class="conversation-row"><div><span class="lin-id">${esc(item.identifier)}</span> <span>${esc(item.title)}</span></div><small class="muted">${esc(taskState(item.state))}</small>${item.response ? `<p>${esc(item.response)}</p>` : ""}</li>`,
    )
    .join("");
  const pending = selected.delivery.filter(
    (entry) => entry.state === "pending" || entry.state === "dead",
  );
  return `${heading}${picker}
    <header class="conversation-heading"><div class="title-row"><h2>${esc(selected.title)}</h2><span class="tag">${esc(status)}</span></div><p class="muted">${esc(selected.summary || status)}</p></header>
    <div class="conversation-links">${links}</div>${waiting}
    <div class="conversation-layout"><section aria-label="Conversation"><h2>Conversation</h2><ol class="conversation-timeline">${timeline || '<li class="empty">The session is starting. Messages will appear here.</li>'}</ol></section>
    <aside class="conversation-details">${plan ? `<section><h2>Plan ${selected.planState && selected.planState !== "sent" ? deliveryBadge(selected.planState) : ""}</h2><ol class="conversation-plan">${plan}</ol></section>` : ""}
    ${files ? `<section><h2>Files</h2><ul class="conversation-files">${files}</ul></section>` : ""}
    ${history ? `<section><h2>Tasks</h2><ul class="conversation-tasks">${history}</ul></section>` : ""}
    ${pending.length ? `<p class="conversation-delivery" role="status">${pending.some((entry) => entry.state === "dead") ? "Some session updates need a delivery retry." : "Session updates are waiting for delivery to Linear."}</p>` : ""}</aside></div>`;
}

function deliveryBadge(state: string, kind?: string): string {
  const label =
    state === "pending"
      ? kind === "prompt"
        ? "Queued prompt"
        : "Pending delivery"
      : state === "dead"
        ? "Delivery failed"
        : state === "dropped"
          ? "Not delivered"
          : state === "cancelled"
            ? "Interrupted"
            : "";
  return label ? `<span class="conversation-delivery-state">${label}</span>` : "";
}

function taskState(state: string): string {
  return (
    (
      {
        completed: "Completed",
        merged: "Merged",
        cancelled: "Stopped",
        running: "Working",
        awaiting_input: "Awaiting input",
        verifying: "Verifying",
        failed: "Needs attention",
        exhausted: "Needs attention",
        queued: "Queued",
      } as Record<string, string>
    )[state] ?? state.replaceAll("_", " ")
  );
}

function planState(state: string): string {
  return (
    (
      {
        pending: "Pending",
        inProgress: "In progress",
        completed: "Completed",
        canceled: "Cancelled",
      } as Record<string, string>
    )[state] ?? state
  );
}
