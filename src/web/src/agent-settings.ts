export type AgentProfile = { agent: "claude" | "codex" | "grok"; model: string | null };
export type AgentRole = "implementer" | "reviewer";
export type AgentSettings = {
  defaults: Record<AgentRole, AgentProfile>;
  projects: { repo: string; implementer?: AgentProfile; reviewer?: AgentProfile }[];
};
export type AgentConnection = {
  ok: boolean;
  agent: AgentProfile["agent"];
  model: string | null;
  models: { id: string; name: string }[];
  message: string;
};
