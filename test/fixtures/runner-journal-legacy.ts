const base = {
  type: "run",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000,
  repository: {
    owner: "acme",
    repo: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    baseSha: "a".repeat(40),
  },
  profile: { agent: "claude", model: "placeholder-model" },
  prompt: "placeholder prompt",
};

const person = {
  email: "person@example.com",
  id: 1,
  login: "person",
  name: "Placeholder Person",
};

const checkpointBot = { appId: "1", id: 2, login: "placeholder[bot]" };

export const LEGACY_EXECUTION_PAYLOADS: readonly {
  shape: string;
  payload: Record<string, unknown>;
}[] = [
  {
    shape: "commitPolicy with bot, projectLead and taskSteerer, no credit",
    payload: {
      ...base,
      commitPolicy: { bot: person, projectLead: person, taskSteerer: person },
    },
  },
  {
    shape: "commitPolicy with empty projectLead and taskSteerer, and checkpointBot",
    payload: {
      ...base,
      checkpointBot,
      commitPolicy: { bot: person, projectLead: {}, taskSteerer: {} },
    },
  },
  {
    shape: "checkpoint true with checkpointBot",
    payload: { ...base, checkpointBot, checkpoint: true },
  },
  {
    shape: "commitPolicy and checkpoint with every optional work field",
    payload: {
      ...base,
      memberId: "member",
      repository: {
        ...base.repository,
        mainSha: "b".repeat(40),
        checkoutExclusions: ["vendor"],
      },
      profile: { ...base.profile, effort: "high" },
      inputFiles: [
        {
          id: "input",
          mimeType: "text/plain",
          path: "notes.txt",
          sha256: "c".repeat(64),
          sizeBytes: 1,
        },
      ],
      promptContext: { sha256: "d".repeat(64), sizeBytes: 1 },
      hooks: [],
      checkpointBot,
      checkpoint: true,
      commitPolicy: { bot: {}, projectLead: person, taskSteerer: {} },
    },
  },
];
