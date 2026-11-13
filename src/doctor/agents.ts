import {
  emptyConfigFile,
  readAgentSettings,
  type AgentProfiles,
  type PawsConfigFile,
} from "../config";

export type DoctorAgentConfig = Pick<PawsConfigFile, "agents" | "agentSettings">;

export function doctorAgentProfiles(input?: DoctorAgentConfig): AgentProfiles[] {
  const config = { ...emptyConfigFile(), ...input };
  return [readAgentSettings(config).defaults];
}
