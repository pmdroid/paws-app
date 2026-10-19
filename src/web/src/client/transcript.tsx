import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown } from "lucide-react";
import { ACTIVITY_KINDS, type StatusActivity } from "../contract";
import { initializeAppearance } from "./appearance";
import { ansiToHtml } from "./ansi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";

const POLL_MS = 3000;
const BOTTOM_SLACK = 48;

type Load =
  | { state: "loading" }
  | { state: "ready"; entries: StatusActivity[] }
  | { state: "failed"; message: string; entries: StatusActivity[] | null };

const KIND_LABEL: Partial<Record<StatusActivity["kind"], string>> = {
  system: "agent",
  err: "error",
  elicitation: "question",
};

const KIND_STYLE: Partial<Record<StatusActivity["kind"], string>> = {
  system: "bg-main text-main-foreground",
  err: "bg-red-200 text-black",
  elicitation: "bg-yellow-200 text-black",
  ok: "bg-green-200 text-black",
};

const time = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function transcriptRunId(pathname: string): string | null {
  const match = /\/runs\/([A-Za-z0-9_-]{1,128})\/transcript\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export function parseTranscript(body: unknown): StatusActivity[] | null {
  if (!Array.isArray(body)) return null;
  const entries: StatusActivity[] = [];
  for (const entry of body) {
    if (
      !entry ||
      typeof entry.at !== "string" ||
      !ACTIVITY_KINDS.includes(entry.kind) ||
      typeof entry.text !== "string"
    )
      return null;
    entries.push({ at: entry.at, kind: entry.kind, text: entry.text });
  }
  return entries;
}

async function fetchTranscript(runId: string): Promise<StatusActivity[]> {
  const response = await fetch(`/api/runs/transcript?run=${encodeURIComponent(runId)}`, {
    headers: { Accept: "application/json", "ngrok-skip-browser-warning": "1" },
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
  return (
    <li className="grid min-w-0 grid-cols-1 gap-2 px-4 py-4 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4 sm:px-5">
      <div className="flex items-center gap-2 sm:flex-col sm:items-start">
        <Badge className={KIND_STYLE[entry.kind] ?? "bg-background"}>
          {KIND_LABEL[entry.kind] ?? entry.kind}
        </Badge>
        <time dateTime={entry.at} className="text-xs tabular-nums opacity-80">
          {Number.isNaN(Date.parse(entry.at)) ? "" : time.format(new Date(entry.at))}
        </time>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {title !== null && (
          <div
            className="min-w-0 font-mono text-xs font-bold leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(title) }}
          />
        )}
        {body && (
          <div
            className={cn(
              "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
              code ? "font-mono text-xs leading-relaxed" : "max-w-[72ch] text-sm leading-relaxed",
            )}
            dangerouslySetInnerHTML={{ __html: ansiToHtml(body) }}
          />
        )}
      </div>
    </li>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-base border-2 border-border bg-secondary-background p-4 text-sm leading-relaxed shadow-shadow">
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
      if (!stopped) timer = window.setTimeout(poll, POLL_MS);
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

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 flex min-h-20 flex-wrap items-center justify-between gap-3 border-b-2 border-border bg-secondary-background px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-xl font-bold tracking-tight">Paws</span>
          <span className="text-sm font-semibold">Agent transcript</span>
        </div>
        {runId && load.state !== "loading" && (
          <Badge
            className={cn(
              "gap-2 px-3 py-1 text-sm",
              live ? "bg-green-200 text-black" : "bg-yellow-200 text-black",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-full border border-black bg-black",
                live && "motion-safe:animate-pulse",
              )}
            />
            {live ? "Live" : "Reconnecting"}
          </Badge>
        )}
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-28 pt-6 sm:px-6 lg:px-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-heading tracking-tight sm:text-4xl">Agent transcript</h1>
          {runId && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm leading-relaxed">
              <span>Run</span>
              <code className="rounded-base bg-secondary-background px-1.5 py-0.5 font-mono text-xs">
                {runId}
              </code>
              {entries && (
                <span className="tabular-nums">
                  {entries.length} {entries.length === 1 ? "entry" : "entries"}
                </span>
              )}
            </p>
          )}
        </div>
        {!runId && (
          <Notice>This link does not name a run. Open the transcript from a run in Paws.</Notice>
        )}
        {runId && load.state === "loading" && <Notice>Loading the transcript…</Notice>}
        {load.state === "failed" && (
          <Notice>
            {load.message}{" "}
            {load.message.startsWith("Sign in") && (
              <a
                href="/status/"
                className="font-semibold underline decoration-2 underline-offset-4 hover:decoration-main"
              >
                Open Paws
              </a>
            )}
          </Notice>
        )}
        {entries && entries.length === 0 && <Notice>Waiting for agent output.</Notice>}
        {entries && entries.length > 0 && (
          <ol
            role="log"
            aria-label="Agent transcript"
            className="m-0 list-none divide-y-2 divide-border rounded-base border-2 border-border bg-secondary-background p-0 shadow-shadow"
          >
            {entries.map((entry, index) => (
              <Entry key={index} entry={entry} />
            ))}
          </ol>
        )}
      </main>
      {away && entries && entries.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-30 flex justify-center px-4">
          <Button
            type="button"
            onClick={jump}
            aria-label={
              fresh > 0 ? `Jump to latest message, ${fresh} new` : "Jump to latest message"
            }
            className="pointer-events-auto px-5 animate-in fade-in slide-in-from-bottom-2 duration-200"
          >
            <ArrowDown aria-hidden="true" />
            <span>{fresh > 0 ? `${fresh} new` : "Latest"}</span>
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
