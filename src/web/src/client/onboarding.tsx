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

function OnboardingPage() {
  const [state, setState] = useState<Onboarding | null>(null);
  const [error, setError] = useState("");
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
                href="/auth/linear"
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
