import {
  emptyConfigFile,
  readAgentSettings,
  resolveAgentProfiles,
  type AgentProfiles,
  type PawsConfigFile,
} from "../config";

export type DoctorAgentConfig = Pick<PawsConfigFile, "agents" | "agentSettings">;

export function doctorAgentProfiles(input?: DoctorAgentConfig): AgentProfiles[] {
  const config = { ...emptyConfigFile(), ...input };
  const settings = readAgentSettings(config);
  return [
    settings.defaults,
    ...settings.projects.map((project) => resolveAgentProfiles(config, project.repo)),
  ];
}
