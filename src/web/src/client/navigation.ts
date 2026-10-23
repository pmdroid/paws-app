import type { Route } from "./route";

export const PAGES = {
  overview: {
    title: "Overview",
    description: "Work delegated in Linear, verified and delivered by Paws.",
  },
  issues: {
    title: "Issues",
    description: "Every issue delegated to Paws, who owns it and what blocks it.",
  },
  projects: {
    title: "Projects",
    description: "Approve selected Linear issues and supervise delivery.",
  },
  runs: {
    title: "Runs",
    description: "Agent activity, execution controls and verification evidence.",
  },
  mergeQueue: {
    title: "Merge queue",
    description: "Every issue Closeout accepted that is waiting to merge, per repository.",
  },
  evidence: {
    title: "Evidence",
    description: "A Closeout video or screenshot the agent published with a run.",
  },
  questions: {
    title: "Questions",
    description: "Review blocked work and answer questions in Linear.",
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
    views: ["overview", "issues", "projects", "questions", "runs", "mergeQueue", "sessions"],
  },
  { label: "Manage", views: ["runners"] },
] as const;
