export type AgentProfile = {
  agent: "claude" | "codex" | "grok";
  model: string | null;
  effort?: string;
};
export type AgentRole = "implementer" | "reviewer";
export type AgentSettings = {
  defaults: Record<AgentRole, AgentProfile>;
  projects: { repo: string; implementer?: AgentProfile; reviewer?: AgentProfile }[];
  /** CI fix attempts. Missing means 3. Settings → Merging owns the other merge choices. */
  merge?: { ciFixAttempts?: number };
  /** How long a task may wait for a runner slot. Missing means 24 hours. */
  queue?: { startTimeoutHours: number };
};
export type AgentModelCatalog = {
  agent: AgentProfile["agent"];
  models: {
    id: string;
    /** "Opus 5.5 · 1M context" for a 1M context entry. */
    name: string;
    longContext?: boolean;
    efforts: { id: string; name: string }[] | null;
  }[];
  efforts: { id: string; name: string }[];
  updatedAt: number;
};
