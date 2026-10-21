export type AgentProfile = {
  agent: "claude" | "codex" | "grok";
  model: string | null;
  effort?: string;
};
export type AgentRole = "implementer" | "reviewer";
export type AgentSettings = {
  defaults: Record<AgentRole, AgentProfile>;
  projects: { repo: string; implementer?: AgentProfile; reviewer?: AgentProfile }[];
  /** Workspace merge settings. A missing switch means off, missing attempts mean 3. */
  merge?: { closeoutAfterUpdate: boolean; ciFixAttempts?: number };
};
export type AgentModelCatalog = {
  agent: AgentProfile["agent"];
  /** `name` is the display label. A 1M context entry is its own model, marked `oneMillion`. */
  models: {
    id: string;
    name: string;
    efforts: { id: string; name: string }[] | null;
    oneMillion?: boolean;
  }[];
  efforts: { id: string; name: string }[];
  updatedAt: number;
};
