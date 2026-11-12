import type { OverviewSetup } from "../contract";
import { esc } from "./format";
import { routeHref } from "./route";

type Step = {
  title: string;
  help: string;
  done: (setup: OverviewSetup) => boolean;
  action?: { label: string; href: string };
};

const STEPS: readonly Step[] = [
  {
    title: "Connect Linear",
    help: "Paws takes work from issues you delegate to it, and asks its questions there.",
    done: () => true,
  },
  {
    title: "Install the GitHub App on your repositories",
    help: "Paws opens and merges pull requests with it.",
    done: (setup) => setup.github,
    action: {
      label: "Install the GitHub App",
      href: routeHref({ view: "settings", page: "integrations" }),
    },
  },
  {
    title: "Enroll a runner",
    help: "A Linux machine that runs the agent. Paws needs at least one before it can start work.",
    done: (setup) => setup.runner,
    action: { label: "Add a runner", href: routeHref({ view: "runners", id: null }) },
  },
  {
    title: "Sign in to an agent on that runner",
    help: "On the Runners page, after the runner is enrolled.",
    done: (setup) => setup.agent,
    action: { label: "Open Runners", href: routeHref({ view: "runners", id: null }) },
  },
  {
    title: "Delegate your first issue in Linear",
    help: "Assign an issue to Paws. It appears on this page within seconds.",
    done: (setup) => setup.delegated,
  },
];

export function renderSetupChecklist(setup: OverviewSetup): string {
  const done = STEPS.map((step) => step.done(setup));
  if (done.every(Boolean)) return "";
  const next = done.indexOf(false);
  const rows = STEPS.map((step, index) => {
    const state = done[index] ? "done" : index === next ? "next" : "todo";
    const marker = done[index] ? "✓" : String(index + 1);
    const action =
      index === next && step.action
        ? `<a class="btn primary self-start" href="${step.action.href}">${esc(step.action.label)}</a>`
        : "";
    return `<li class="flex gap-3 border-t border-border py-3 first:border-t-0${state === "next" ? "" : " text-muted-foreground"}" data-setup-step="${state}"${state === "next" ? ' aria-current="step"' : ""}>
      <span class="grid size-6 shrink-0 place-items-center rounded-full border border-current font-mono text-xs${state === "next" ? " text-state-awaiting" : ""}" aria-hidden="true">${marker}</span>
      <div class="flex min-w-0 flex-col gap-1"><b class="${state === "todo" ? "font-normal" : ""}">${esc(step.title)}</b><span class="muted text-sm">${esc(step.help)}</span>${action}</div>
    </li>`;
  }).join("");
  const count = done.filter(Boolean).length;
  return `<section class="overview-section" aria-labelledby="setup-heading" data-setup-checklist><h2 id="setup-heading">Set up Paws <span class="cnt">${count} of ${STEPS.length} done</span></h2><ol class="flex flex-col" role="list">${rows}</ol></section>`;
}
