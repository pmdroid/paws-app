export type ContextViewSource = { kind: string; id: string; url: string | null; revision: string };

export type ContextViewRecord = {
  id: string;
  version: number;
  classification: string;
  text: string;
  status: "current" | "superseded";
  corrected: boolean;
  observedAt: number;
  source: ContextViewSource;
};

export type ContextViewSummary = {
  version: number;
  builtAt: number | null;
  state: "current" | "stale" | "rebuilding";
  body: string;
  covered: number;
  decisions: number;
  questions: number;
  sources: ContextViewSource[];
};

export type ContextView = {
  scope: { kind: string; id: string; name: string | null; url: string | null };
  updatedAt: number | null;
  summaries: ContextViewSummary[];
  decisions: ContextViewRecord[];
  questions: ContextViewRecord[];
  records: ContextViewRecord[];
  page: { offset: number; limit: number; search: string; more: boolean };
};

export type ContextViewDetail = {
  record: ContextViewRecord & { body: string; actorId: string | null; correctedBy: string | null };
  versions: { version: number; status: string; observedAt: number }[];
};

export type ContextProject = { id: string; name: string | null; items: number };
