import { journalCaught } from "../journal";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown } from "lucide-react";
import { ACTIVITY_KINDS, type StatusActivity, type TranscriptEntry } from "../contract";
import { initializeAppearance } from "./appearance";
import { ansiToHtml } from "./ansi";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";
import { dashboardPath } from "../../../dashboard-links";

const POLL_MS = 3000;
const BOTTOM_SLACK = 48;

type Load =
  | { state: "loading" }
  | { state: "ready"; entries: TranscriptEntry[] }
  | { state: "failed"; message: string; entries: TranscriptEntry[] | null };

const KIND_LABEL: Partial<Record<StatusActivity["kind"], string>> = {
  system: "agent",
  ok: "result",
  err: "error",
  elicitation: "question",
  prompt: "handoff",
};

const KIND_COLOR: Partial<Record<string, string>> = {
  agent: "text-state-running",
  result: "text-state-ok",
  handoff: "text-state-recovering",
  turn: "text-state-verifying",
  error: "text-state-failed",
};

/** The short label and color class of a transcript line. */
export function entryKind(entry: StatusActivity): { label: string; color: string } {
  const label =
    entry.kind === "system" && entry.text.startsWith("Agent turn ended")
      ? "turn"
      : (KIND_LABEL[entry.kind] ?? entry.kind);
  return { label, color: KIND_COLOR[label] ?? "text-muted-foreground" };
}

const time = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

const startTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function transcriptRunId(pathname: string): string | null {
  const match = /\/runs\/([A-Za-z0-9_-]{1,128})\/transcript\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export function parseTranscript(body: unknown): TranscriptEntry[] | null {
  if (!Array.isArray(body)) return null;
  const entries: TranscriptEntry[] = [];
  for (const entry of body) {
    if (
      !entry ||
      typeof entry.at !== "string" ||
      !ACTIVITY_KINDS.includes(entry.kind) ||
      typeof entry.text !== "string" ||
      !Number.isInteger(entry.session) ||
      entry.session < 1
    )
      return null;
    entries.push({ at: entry.at, kind: entry.kind, text: entry.text, session: entry.session });
  }
  return entries;
}

interface TranscriptSession {
  session: number;
  entries: TranscriptEntry[];
}

function transcriptSessions(entries: TranscriptEntry[]): TranscriptSession[] {
  const sessions: TranscriptSession[] = [];
  for (const entry of entries) {
    const last = sessions.at(-1);
    if (last?.session === entry.session) last.entries.push(entry);
    else sessions.push({ session: entry.session, entries: [entry] });
  }
  return sessions;
}

async function fetchTranscript(runId: string): Promise<TranscriptEntry[]> {
  const response = await fetch(`/api/runs/transcript?run=${encodeURIComponent(runId)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("Sign in to Paws to read this transcript.");
  if (response.status === 404 || response.status === 403)
    throw new Error("This run has no transcript you can read.");
  if (!response.ok) throw new Error(`Paws responded ${response.status}. Retrying.`);
  const entries = parseTranscript(await response.json());
  if (!entries) throw new Error("Paws sent a transcript this page cannot read. Retrying.");
  return entries;
}

function atBottom(): boolean {
  const page = document.documentElement;
  return window.innerHeight + window.scrollY >= page.scrollHeight - BOTTOM_SLACK;
}

function scrollToBottom(smooth: boolean): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: smooth && !reduced ? "smooth" : "instant",
  });
}

function Entry({ entry }: { entry: StatusActivity }) {
  const code = entry.kind === "tool" || entry.kind === "err";
  const split = entry.text.indexOf("\n");
  const title = code && split > 0 ? entry.text.slice(0, split) : code ? entry.text : null;
  const body = title === null ? entry.text : entry.text.slice(title.length + 1);
  const kind = entryKind(entry);
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-[13px] leading-relaxed sm:grid-cols-[auto_4.5rem_minmax(0,1fr)] sm:px-4">
      <time dateTime={entry.at} className="tabular-nums text-muted-foreground">
        {Number.isNaN(Date.parse(entry.at)) ? "" : time.format(new Date(entry.at))}
      </time>
      <span data-kind={kind.label} className={cn("truncate", kind.color)}>
        {kind.label}
      </span>
      <div className="col-span-full flex min-w-0 flex-col gap-1 sm:col-span-1">
        {title !== null && (
          <div
            className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(title) }}
          />
        )}
        {body && (
          <div
            className={cn(
              "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
              code
                ? "rounded-md border border-border bg-background p-2 text-muted-foreground"
                : "max-w-[96ch]",
            )}
            dangerouslySetInnerHTML={{ __html: ansiToHtml(body) }}
          />
        )}
      </div>
    </li>
  );
}

function Session({ session, latest }: { session: TranscriptSession; latest: boolean }) {
  const at = session.entries[0]!.at;
  return (
    <section aria-label={`Session ${session.session}`} className="flex flex-col gap-2">
      <h2 className="font-mono text-xs text-muted-foreground">
        Session {session.session}
        {Number.isNaN(Date.parse(at)) ? "" : `, started ${startTime.format(new Date(at))}`}
      </h2>
      <ol
        role={latest ? "log" : undefined}
        aria-label={latest ? "Agent transcript" : `Session ${session.session} transcript`}
        className="m-0 list-none rounded-md border border-border bg-card py-2"
      >
        {session.entries.map((entry, index) => (
          <Entry key={index} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

export function TranscriptSessions({ entries }: { entries: TranscriptEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const sessions = transcriptSessions(entries);
  const latest = sessions.at(-1);
  if (!latest) return null;
  const earlier = sessions.slice(0, -1);
  return (
    <>
      {earlier.length > 0 && (
        <Button
          type="button"
          variant="neutral"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="self-start"
        >
          Earlier sessions ({earlier.length})
        </Button>
      )}
      {expanded &&
        earlier.map((session) => (
          <Session key={session.session} session={session} latest={false} />
        ))}
      <Session key={latest.session} session={latest} latest />
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card p-4 text-sm leading-relaxed">
      {children}
    </div>
  );
}

function TranscriptPage({ runId }: { runId: string | null }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [away, setAway] = useState(false);
  const [seen, setSeen] = useState(0);
  const stick = useRef(true);
  const jumping = useRef(false);
  const count = useRef(0);
  const entries =
    load.state === "ready" ? load.entries : load.state === "failed" ? load.entries : null;
  count.current = entries?.length ?? 0;

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let timer = 0;
    let last = "";
    const poll = async () => {
      if (!document.hidden) {
        try {
          const next = await fetchTranscript(runId);
          const key = JSON.stringify(next);
          const same = key === last;
          last = key;
          if (!stopped)
            setLoad((current) =>
              same && current.state === "ready" ? current : { state: "ready", entries: next },
            );
        } catch (caught) {
          journalCaught(caught, "transcript.TranscriptPage.fetchTranscript", null);
          if (!stopped)
            setLoad((current) => ({
              state: "failed",
              message: caught instanceof Error ? caught.message : "Could not load the transcript.",
              entries:
                current.state === "ready"
                  ? current.entries
                  : current.state === "failed"
                    ? current.entries
                    : null,
            }));
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    history.scrollRestoration = "manual";
    const onScroll = () => {
      const bottom = atBottom();
      if (jumping.current) {
        if (bottom) jumping.current = false;
        return;
      }
      if (bottom === stick.current) return;
      stick.current = bottom;
      setAway(!bottom);
      if (!bottom) setSeen(count.current);
    };
    const interrupt = () => {
      jumping.current = false;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", interrupt, { passive: true });
    window.addEventListener("touchstart", interrupt, { passive: true });
    window.addEventListener("keydown", interrupt);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", interrupt);
      window.removeEventListener("touchstart", interrupt);
      window.removeEventListener("keydown", interrupt);
    };
  }, []);

  useLayoutEffect(() => {
    if (stick.current) scrollToBottom(false);
  }, [entries]);

  const jump = () => {
    stick.current = true;
    jumping.current = true;
    setAway(false);
    scrollToBottom(true);
  };

  const fresh = Math.max(0, (entries?.length ?? 0) - seen);
  const live = load.state === "ready";
  const sessionCount = entries?.at(-1)?.session ?? 0;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-3 py-3 sm:px-4">
          <h1 className="text-base font-heading tracking-tight">Agent transcript</h1>
          {runId && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {load.state !== "loading" && (
                <span
                  role="status"
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-current/40 px-2 py-0.5 font-mono text-xs",
                    live ? "text-state-running" : "text-state-warn",
                  )}
                >
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                  {live ? "live" : "reconnecting"}
                </span>
              )}
              <p className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={runId}>
                run {runId}
                {sessionCount > 0 &&
                  ` · ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`}
                {entries && ` · ${entries.length} ${entries.length === 1 ? "line" : "lines"}`}
              </p>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 pb-20 pt-3 sm:px-4 sm:pt-4">
        {!runId && (
          <Notice>This link does not name a run. Open the transcript from a run in Paws.</Notice>
        )}
        {runId && load.state === "loading" && <Notice>Loading the transcript…</Notice>}
        {load.state === "failed" && (
          <Notice>
            {load.message}{" "}
            {load.message.startsWith("Sign in") && (
              <a href={dashboardPath()} className="font-semibold underline underline-offset-4">
                Open Paws
              </a>
            )}
          </Notice>
        )}
        {entries && entries.length === 0 && <Notice>Waiting for agent output.</Notice>}
        {entries && entries.length > 0 && <TranscriptSessions entries={entries} />}
      </main>
      {away && entries && entries.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-30 flex justify-center px-4">
          <Button
            type="button"
            onClick={jump}
            aria-label={
              fresh > 0 ? `Jump to latest message, ${fresh} new` : "Jump to latest message"
            }
            className="pointer-events-auto px-4"
          >
            <ArrowDown aria-hidden="true" />
            <span>
              Latest
              {fresh > 0 && (
                <span className="ml-2 border-l border-current/30 pl-2 tabular-nums">
                  {fresh} new
                </span>
              )}
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}

const root = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("#app");
if (root) {
  initializeAppearance();
  const runId = transcriptRunId(location.pathname);
  document.title = runId ? `Transcript · ${runId} · Paws` : "Transcript · Paws";
  createRoot(root).render(<TranscriptPage runId={runId} />);
}
