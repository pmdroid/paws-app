import type { Route } from "./route";

export const PAGES = {
  overview: {
    title: "Overview",
    description: "Work delegated in Linear, verified and delivered by Paws.",
  },
  epics: { title: "Epics", description: "Related work delegated from Linear." },
  projects: {
    title: "Projects",
    description: "Approve selected Linear issues and supervise delivery.",
  },
  runs: {
    title: "Runs",
    description: "Inspect agent activity, execution controls, and verification output.",
  },
  questions: {
    title: "Questions",
    description: "Review blocked work and answer questions in Linear.",
  },
  verdicts: {
    title: "Verification",
    description: "Inspect Closeout checks and the evidence for each candidate.",
  },
  queue: {
    title: "Merge queue",
    description: "Follow pull requests through serial verification and delivery.",
  },
  sessions: {
    title: "Conversations",
    description: "Read Linear sessions and start a conversation on an issue or comment thread.",
  },
  runners: {
    title: "Runners",
    description: "Manage the hosts that execute work delegated in Linear.",
  },
  settings: {
    title: "Settings",
    description: "Configure agents, account connections, and workspace access.",
  },
} satisfies Record<Route["view"], { title: string; description: string }>;

export const NAVIGATION = [
  {
    label: "Work",
    views: ["overview", "projects", "epics", "runs", "questions", "verdicts", "queue", "sessions"],
  },
  { label: "Manage", views: ["runners"] },
] as const;
