import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Agent = "claude" | "codex";
type Summary = {
  runner: { id: string; name: string } | null;
  agents: { agent: Agent; state: string; updatedAt: number | null }[];
  ready: boolean;
};
type Challenge = {
  id: string;
  agent: Agent;
  state: string;
  expiresAt: number;
  terminal: string;
  authorization: { url: string; message: string } | null;
};
const endpoint = "/api/workspaces/onboarding/agents";
const pending = (state: string) => state === "starting" || state === "waiting";
const name = (agent: Agent) => (agent === "claude" ? "Claude" : "Codex");

function providerUrl(value: string, agent: Agent) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (agent === "codex"
        ? url.hostname === "auth.openai.com"
        : ["claude.ai", "console.anthropic.com"].includes(url.hostname))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function OnboardingAgents({ runnerId }: { runnerId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [privateLogin, setPrivateLogin] = useState<Challenge | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const challenge = useRef<Challenge | null>(null);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const match = /^\/status\/onboarding\/([A-Za-z0-9_-]{1,128})\/(0|[1-9][0-9]{0,9})\/?$/.exec(
    window.location.pathname,
  );
  const context = { session: match?.[1] ?? "", generation: Number(match?.[2]), runnerId };
  const query = new URLSearchParams({
    session: context.session,
    generation: String(context.generation),
  });
  function clearPrivate() {
    challenge.current = null;
    setPrivateLogin(null);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
      challenge.current = null;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(`${endpoint}?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const current: Summary = await response.json();
        if (current.runner?.id !== runnerId) throw new Error();
        if (controller.signal.aborted) return;
        setSummary(current);
        const active = challenge.current;
        if (active) {
          const read = await fetch(
            `${endpoint}/${active.agent}/login/${active.id}?${query}&runnerId=${encodeURIComponent(runnerId)}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!read.ok) throw new Error();
          const latest: Challenge = await read.json();
          if (controller.signal.aborted || challenge.current?.id !== active.id) return;
          if (pending(latest.state)) {
            challenge.current = latest;
            setPrivateLogin(latest);
          } else clearPrivate();
        }
        setError("");
        timer = setTimeout(refresh, 2000);
      } catch {
        if (!controller.signal.aborted) {
          clearPrivate();
          setSummary(null);
          setError("Agent sign-in could not be refreshed. Check your selected VM and try again.");
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runnerId, revision]);

  async function mutate(agent: Agent, action: "start" | "cancel" | "input", input?: string) {
    setBusy(true);
    setError("");
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    try {
      const session = await fetch("/api/auth/session", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!session.ok) throw new Error();
      const auth: { csrfToken: string } = await session.json();
      if (!auth.csrfToken) throw new Error();
      const active = challenge.current;
      if (action !== "start" && (!active || active.agent !== agent)) throw new Error();
      const suffix =
        action === "start" ? "" : `/${active!.id}${action === "input" ? "/input" : ""}`;
      const response = await fetch(`${endpoint}/${agent}/login${suffix}`, {
        method: action === "cancel" ? "DELETE" : "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Paws-CSRF": auth.csrfToken },
        body: JSON.stringify({
          ...context,
          ...(action === "input" ? { input: { text: input } } : {}),
        }),
      });
      if (!response.ok) throw new Error();
      const result: Challenge = await response.json();
      if (!alive.current || controller.signal.aborted) return;
      if (action !== "cancel" && result.id && pending(result.state)) {
        challenge.current = result;
        setPrivateLogin(result);
      } else clearPrivate();
      setRevision((value) => value + 1);
    } catch {
      if (alive.current && !controller.signal.aborted) {
        clearPrivate();
        setError("Agent sign-in is unavailable. Refresh the accounts and try again.");
      }
    } finally {
      if (alive.current && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Your agent accounts"
      className="space-y-5 rounded-base border-2 border-border bg-secondary-background p-5 shadow-shadow sm:p-6"
    >
      <div className="space-y-2">
        <h2 className="text-xl font-bold">Claude and Codex on your VM</h2>
        <p className="text-sm">{summary?.runner ? summary.runner.name : "Checking selected VM…"}</p>
        <p role="status" className="text-sm font-semibold">
          {summary?.ready
            ? "Both agent accounts are ready"
            : "Both Claude and Codex must be connected"}
        </p>
      </div>
      {error && (
        <div role="alert" className="space-y-3">
          <p className="text-sm">{error}</p>
          <Button
            disabled={busy}
            variant="neutral"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh agent accounts
          </Button>
        </div>
      )}
      {summary && (
        <div className="divide-y-2 divide-border">
          {summary.agents.map((account) => (
            <div key={account.agent} className="space-y-3 py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-bold">{name(account.agent)}</h3>
                <span className="text-sm capitalize">{account.state.replaceAll("_", " ")}</span>
              </div>
              {account.state !== "connected" && (
                <Button
                  disabled={busy || privateLogin !== null}
                  onClick={() => void mutate(account.agent, "start")}
                >
                  {pending(account.state)
                    ? `Open ${name(account.agent)} sign-in`
                    : `Sign in to ${name(account.agent)}`}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {privateLogin && (
        <section
          aria-label={`Private ${name(privateLogin.agent)} sign-in`}
          className="space-y-4 border-t-2 border-border pt-5"
        >
          <h3 className="font-bold">Private {name(privateLogin.agent)} sign-in</h3>
          <p className="text-sm">
            Expires at {new Date(privateLogin.expiresAt).toLocaleTimeString()}.
          </p>
          {privateLogin.terminal && (
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm"
              tabIndex={0}
            >
              {privateLogin.terminal}
            </pre>
          )}
          {privateLogin.authorization && (
            <div className="space-y-3">
              <p className="whitespace-pre-wrap break-words text-sm">
                {privateLogin.authorization.message}
              </p>
              {providerUrl(privateLogin.authorization.url, privateLogin.agent) && (
                <a
                  className="inline-flex min-h-control items-center font-semibold underline underline-offset-4"
                  href={providerUrl(privateLogin.authorization.url, privateLogin.agent)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open {name(privateLogin.agent)} sign-in
                </a>
              )}
            </div>
          )}
          {privateLogin.agent === "claude" && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const input = new FormData(form).get("reply");
                form.reset();
                if (typeof input === "string" && input) void mutate("claude", "input", input);
              }}
            >
              <label className="flex flex-col gap-2 text-sm font-semibold">
                Claude sign-in reply
                <Input
                  name="reply"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  required
                  disabled={busy}
                />
              </label>
              <Button type="submit" disabled={busy}>
                Send reply
              </Button>
            </form>
          )}
          <Button
            variant="neutral"
            disabled={busy}
            onClick={() => void mutate(privateLogin.agent, "cancel")}
          >
            Cancel sign-in
          </Button>
        </section>
      )}
    </section>
  );
}
