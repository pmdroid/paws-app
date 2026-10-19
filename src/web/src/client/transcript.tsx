import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown } from "lucide-react";
import { ACTIVITY_KINDS, type StatusActivity } from "../contract";
import { initializeAppearance } from "./appearance";
import { ansiToHtml } from "./ansi";
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
    <li className="min-w-0 space-y-3 px-4 py-5 sm:px-7 sm:py-6">
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span
          className={cn(
            "font-semibold capitalize",
            entry.kind === "err" && "text-red-700 dark:text-red-300",
          )}
        >
          {KIND_LABEL[entry.kind] ?? entry.kind}
        </span>
        <time dateTime={entry.at} className="shrink-0 tabular-nums opacity-70">
          {Number.isNaN(Date.parse(entry.at)) ? "" : time.format(new Date(entry.at))}
        </time>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {title !== null && (
          <div
            className="min-w-0 font-mono text-[13px] font-semibold leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(title) }}
          />
        )}
        {body && (
          <div
            className={cn(
              "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
              code
                ? "rounded-base bg-background/25 p-3 font-mono text-[13px] leading-relaxed sm:p-4"
                : "max-w-[72ch] text-[15px] leading-7",
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
      <header className="sticky top-0 z-20 border-b-2 border-border bg-secondary-background">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0 space-y-1">
            <h1 className="text-lg font-heading tracking-tight">Agent transcript</h1>
            {runId && (
              <p className="truncate font-mono text-[11px] opacity-70" title={runId}>
                {runId}
              </p>
            )}
          </div>
          {runId && load.state !== "loading" && (
            <span role="status" className="flex shrink-0 items-center gap-2 text-xs">
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", live ? "bg-foreground" : "bg-main")}
              />
              {live ? "Auto-updating" : "Reconnecting"}
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-24 pt-5 sm:px-6 sm:pt-6">
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
            className="m-0 list-none divide-y divide-foreground/15 rounded-base border-2 border-border bg-secondary-background p-0 shadow-shadow"
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
