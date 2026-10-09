import { createInterface } from "node:readline";
import { GROK_LOGIN_MESSAGE, resolveGrokCommand } from "../acp";
import {
  isImplementer,
  writeImplementer,
  type AgentsConfig,
  type EnvSource,
  type ImplementerName,
} from "../config";

export type SetupCandidate = {
  id: ImplementerName;
  installed: boolean;
  /** The binary is present, so its login command can be run. */
  loginable: boolean;
  loginCommand: string;
};

const LOGIN_COMMAND: Record<ImplementerName, string> = {
  claude: "claude",
  grok: "grok login",
  codex: "codex login",
};

export function detectCandidates(input: {
  env?: EnvSource;
  which: (bin: string) => string | null;
  agents?: AgentsConfig;
  packageRoot?: string;
}): SetupCandidate[] {
  const env = input.env ?? {};
  const agents = input.agents;
  return [
    candidate(
      "claude",
      input.which(configured(env, "PAWS_CLAUDE_ACP") ?? "claude-agent-acp") !== null,
    ),
    candidate("grok", grokReady(input.which, agents, input.packageRoot)),
    candidate("codex", input.which(configured(env, "PAWS_CODEX_ACP") ?? "codex-acp") !== null),
  ];
}

/** Menu of installed implementers. Prints the list and returns the choice. */
export async function selectImplementer(options: {
  candidates: SetupCandidate[];
  choice?: string;
  readLine?: () => Promise<string | null>;
  write?: (text: string) => void;
}): Promise<SetupCandidate | null> {
  const write = options.write ?? ((text) => process.stdout.write(text));
  const offered = options.candidates.filter((item) => item.installed && item.loginable);
  if (offered.length === 0) {
    write(
      "No implementer is installed.\nInstall Claude Code (claude-agent-acp), Grok (`bun install` provides node_modules/.bin/grok), or Codex (codex-acp).\n",
    );
    return null;
  }
  write("Choose the implementer Paws will run. Only installed, loginable agents are listed.\n");
  offered.forEach((item, index) => {
    write(`  ${index + 1}) ${item.id}: Run \`${item.loginCommand}\`\n`);
  });
  const raw = options.choice ?? (await (options.readLine ?? readStdin)()) ?? "";
  const selected = matchChoice(raw.trim(), offered);
  if (selected === null) {
    write(`Choose one of: ${offered.map((item) => item.id).join(", ")}.\n`);
    return null;
  }
  return selected;
}

export async function runSetup(options: {
  configPath: string;
  candidates: SetupCandidate[];
  choice?: string;
  readLine?: () => Promise<string | null>;
  write?: (text: string) => void;
}): Promise<number> {
  const write = options.write ?? ((text) => process.stdout.write(text));
  const selected = await selectImplementer(options);
  if (selected === null) return 1;
  writeImplementer(options.configPath, selected.id);
  write(`Wrote agents.implementer = "${selected.id}"\n`);
  write(loginLine(selected));
  return 0;
}

export function loginLine(selected: SetupCandidate): string {
  return selected.id === "grok" ? `${GROK_LOGIN_MESSAGE}\n` : `Run \`${selected.loginCommand}\`\n`;
}

export async function readStdinLine(stdin: NodeJS.ReadableStream): Promise<string | null> {
  const lines = createInterface({ input: stdin });
  try {
    for await (const line of lines) return line;
    return null;
  } finally {
    lines.close();
  }
}

function readStdin(): Promise<string | null> {
  return readStdinLine(process.stdin);
}

function candidate(id: ImplementerName, installed: boolean): SetupCandidate {
  return {
    id,
    installed,
    loginable: installed,
    loginCommand: LOGIN_COMMAND[id],
  };
}

function grokReady(
  which: (bin: string) => string | null,
  agents: AgentsConfig | undefined,
  packageRoot: string | undefined,
): boolean {
  const resolved = resolveGrokCommand(agents, packageRoot);
  if (resolved.error) return false;
  if (resolved.command.includes("/")) return true;
  return which(resolved.command) !== null;
}

function configured(env: EnvSource, key: string): string | null {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) return null;
  return value.trim().split(/\s+/)[0] ?? null;
}

function matchChoice(raw: string, offered: readonly SetupCandidate[]): SetupCandidate | null {
  if (raw.length === 0) return null;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= offered.length) {
    return offered[asNumber - 1] ?? null;
  }
  const name = raw.toLowerCase();
  if (!isImplementer(name)) return null;
  return offered.find((item) => item.id === name) ?? null;
}
