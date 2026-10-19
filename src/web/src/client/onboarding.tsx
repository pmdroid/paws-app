import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, GitBranch, Monitor, RefreshCw } from "lucide-react";
import { AppearanceControl, initializeAppearance } from "./appearance";
import { Button } from "./ui/button";

export type Onboarding = {
  issue: { id: string; identifier: string; title: string };
  linear: { state: string; detail: string };
  github: { state: string; detail: string };
  vm: { state: string; detail: string };
};

type GitHubLink = {
  configured: boolean;
  identity: { id: number; login: string; expiresAt: number | null } | null;
};

function OnboardingPage() {
  const [state, setState] = useState<Onboarding | null>(null);
  const [error, setError] = useState("");
  const [github, setGitHub] = useState<GitHubLink | null>(null);
  const [githubError, setGitHubError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const match = /^\/status\/onboarding\/([A-Za-z0-9_-]{1,128})\/(0|[1-9][0-9]{0,9})\/?$/.exec(
      window.location.pathname,
    );
    if (!match) {
      setError("Open onboarding from your current Linear assignment.");
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(
          `/api/workspaces/onboarding?session=${encodeURIComponent(match![1]!)}&generation=${match![2]}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          setGitHub(null);
          setState(null);
          setError(
            response.status === 401
              ? "Sign in to Paws with the Linear account for this assignment."
              : response.status === 404
                ? "This onboarding is unavailable. Open your current assignment in Linear."
                : "Paws could not refresh onboarding. Try again.",
          );
          return;
        }
        setState(await response.json());
        setError("");
        try {
          const link = await fetch("/api/workspaces/member-github", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!link.ok) throw new Error();
          const body: GitHubLink = await link.json();
          if (
            typeof body.configured !== "boolean" ||
            (body.identity !== null && typeof body.identity?.login !== "string")
          )
            throw new Error();
          setGitHub(body);
          setGitHubError("");
        } catch {
          if (!controller.signal.aborted) {
            setGitHub(null);
            setGitHubError("GitHub connection could not be refreshed. Try again.");
          }
        }
        timer = setTimeout(refresh, 5000);
      } catch {
        if (!controller.signal.aborted) {
          setState(null);
          setError("Paws could not refresh onboarding. Check your connection and try again.");
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision]);
  async function changeGitHub(method: "POST" | "DELETE") {
    setBusy(true);
    setGitHubError("");
    try {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok) throw new Error();
      const auth: { csrfToken?: string } = await session.json();
      if (!auth.csrfToken) throw new Error();
      const match = /^\/status\/onboarding\/([A-Za-z0-9_-]{1,128})\/(0|[1-9][0-9]{0,9})\/?$/.exec(
        window.location.pathname,
      );
      if (!match) throw new Error();
      const response = await fetch("/api/workspaces/member-github", {
        method,
        headers: { "Content-Type": "application/json", "X-Paws-CSRF": auth.csrfToken },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                onboarding: { sessionId: match[1], generation: Number(match[2]) },
              }),
            }
          : {}),
      });
      if (!response.ok) throw new Error();
      if (method === "POST") {
        const result: { authorizeUrl: string } = await response.json();
        const target = new URL(result.authorizeUrl);
        if (
          target.origin !== "https://github.com" ||
          target.pathname !== "/login/oauth/authorize" ||
          target.username ||
          target.password
        )
          throw new Error();
        window.location.assign(target.href);
      } else {
        setGitHub(null);
        setRevision((value) => value + 1);
      }
    } catch {
      setGitHub(null);
      setGitHubError(
        method === "POST"
          ? "GitHub sign-in could not start. Try again."
          : "GitHub could not be unlinked. Refresh the connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-dvh px-4 py-5 sm:px-8 sm:py-8">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <a href="/status/" className="text-xl font-bold underline-offset-4 hover:underline">
          Paws
        </a>
        <AppearanceControl />
      </header>
      <main className="mx-auto mt-10 max-w-3xl space-y-7 sm:mt-14">
        <div className="space-y-3">
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">Your issue setup</h1>
          {state && (
            <p className="break-words text-lg leading-relaxed">
              <strong>{state.issue.identifier}</strong> · {state.issue.title}
            </p>
          )}
        </div>
        {error ? (
          <div
            className="space-y-4 rounded-base border-2 border-border bg-secondary-background p-5 shadow-shadow"
            role="alert"
          >
            <p>{error}</p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => setRevision((value) => value + 1)}>
                <RefreshCw aria-hidden="true" size={18} />
                Try again
              </Button>
              <a
                href={`/auth/linear?return=${encodeURIComponent(window.location.pathname.replace(/\/$/, ""))}`}
                className="flex min-h-control items-center px-2 font-semibold underline underline-offset-4"
              >
                Sign in with Linear
              </a>
            </div>
          </div>
        ) : state ? (
          <>
            <section
              aria-label="Assignment setup"
              className="overflow-hidden rounded-base border-2 border-border bg-secondary-background shadow-shadow"
            >
              <ol className="divide-y-2 divide-border">
                {[
                  { name: "Linear", label: "Connected", step: state.linear, Icon: Check },
                  { name: "GitHub", label: "Not checked", step: state.github, Icon: GitBranch },
                  { name: "Your VM", label: "Not linked", step: state.vm, Icon: Monitor },
                ].map(({ name, label, step, Icon }) => (
                  <li key={name} className="flex items-start gap-4 p-5 sm:p-6">
                    <Icon aria-hidden="true" size={24} className="mt-1 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h2 className="text-xl font-bold">{name}</h2>
                        <span className="text-sm font-semibold">{label}</span>
                      </div>
                      <p className="max-w-[65ch] text-sm leading-6">{step.detail}</p>
                      {name === "GitHub" && (
                        <div className="space-y-3 pt-2">
                          {github ? (
                            <>
                              <p className="text-sm font-semibold">
                                {github.identity
                                  ? `@${github.identity.login} connected`
                                  : "No GitHub account connected"}
                              </p>
                              <div className="flex flex-wrap gap-3">
                                {github.configured && (
                                  <Button disabled={busy} onClick={() => void changeGitHub("POST")}>
                                    {busy
                                      ? "Working…"
                                      : github.identity
                                        ? "Use another GitHub account"
                                        : "Connect GitHub"}
                                  </Button>
                                )}
                                {github.identity && (
                                  <Button
                                    variant="neutral"
                                    disabled={busy}
                                    onClick={() => void changeGitHub("DELETE")}
                                  >
                                    Unlink GitHub
                                  </Button>
                                )}
                              </div>
                              {!github.configured && (
                                <p className="text-sm">GitHub sign-in is not configured.</p>
                              )}
                            </>
                          ) : (
                            !githubError && (
                              <p className="text-sm" role="status">
                                Loading GitHub connection…
                              </p>
                            )
                          )}
                          {githubError && (
                            <div className="space-y-3" role="alert">
                              <p className="text-sm">{githubError}</p>
                              <Button
                                variant="neutral"
                                disabled={busy}
                                onClick={() => {
                                  setGitHubError("");
                                  setRevision((value) => value + 1);
                                }}
                              >
                                Refresh GitHub connection
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <div className="space-y-3 text-sm leading-6">
              <p>
                Your assignment waits for setup. You can close this page and reopen it from your
                Linear session, or Stop the assignment in Linear.
              </p>
            </div>
          </>
        ) : (
          <p role="status">Loading your assignment…</p>
        )}
      </main>
    </div>
  );
}

if (typeof document !== "undefined") {
  initializeAppearance();
  const root = document.getElementById("app");
  if (root) createRoot(root).render(<OnboardingPage />);
}
