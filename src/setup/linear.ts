import { createPersonalLinearClient, fetchLinearViewerId, type CommentQuery } from "../comments";
import { createLinearClient, type FetchLike, type LinearAuth } from "../linear";
import type { LinearModeFlag } from "./args";
import type { SetupFetch, SetupIO } from "./io";
import { stop, SetupStopped } from "./stop";

export type LinearTeam = {
  id: string;
  key: string;
  name: string;
};

const TEAMS = `query Teams {
  teams(first: 50) {
    nodes { id name key }
  }
}`;

const LABELS = `query TeamLabels($id: String!) {
  team(id: $id) {
    labels(first: 50) {
      nodes { id name }
    }
  }
}`;

const CREATE_LABEL = `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name }
  }
}`;

const PAWS_LABEL = "paws";

export async function connectLinear(input: {
  mode: LinearModeFlag;
  secret: string;
  fetch?: SetupFetch;
}): Promise<{ client: CommentQuery; viewerId: string }> {
  const client = linearClient(input.mode, input.secret, input.fetch);
  try {
    const viewerId = await fetchLinearViewerId(client);
    return { client, viewerId };
  } catch (error) {
    if (error instanceof SetupStopped) throw error;
    if (error instanceof Error && error.message === "Linear viewer id was missing") {
      stop(viewerMissing(input.mode));
    }
    stop(explainLinear(error, input.mode, "checking the Linear viewer"));
  }
}

export async function chooseTeam(input: {
  client: CommentQuery;
  mode: LinearModeFlag;
  wanted: string | null;
  yes: boolean;
  io: SetupIO;
}): Promise<LinearTeam> {
  let teams: LinearTeam[];
  try {
    teams = await fetchTeams(input.client);
  } catch (error) {
    if (error instanceof SetupStopped) throw error;
    stop(explainLinear(error, input.mode, "listing Linear teams"));
  }
  if (teams.length === 0) stop(noTeams(input.mode));
  if (input.wanted !== null && input.wanted.trim().length > 0) {
    return requireTeam(teams, input.wanted.trim());
  }
  if (teams.length === 1) {
    const only = teams[0];
    if (only === undefined) stop(noTeams(input.mode));
    return only;
  }
  const keys = teams.map((team) => team.key).join(", ");
  const needed = `More than one Linear team is visible (${keys}). Pass --linear-team with a team key.`;
  if (input.yes) stop(needed);
  input.io.stdout(`Linear teams: ${keys}`);
  input.io.stdout("Team key:");
  const answer = (await input.io.readLine())?.trim() ?? "";
  if (answer.length === 0) stop(needed);
  return requireTeam(teams, answer);
}

/** Creates the `paws` label when the team does not already have one. */
export async function ensurePawsLabel(
  client: CommentQuery,
  teamId: string,
  mode: LinearModeFlag,
): Promise<void> {
  let names: string[];
  try {
    names = await fetchLabelNames(client, teamId);
  } catch (error) {
    if (error instanceof SetupStopped) throw error;
    stop(explainLinear(error, mode, "reading team labels"));
  }
  if (names.some((name) => name.toLowerCase() === PAWS_LABEL)) return;
  try {
    const data = await client.query(CREATE_LABEL, {
      input: {
        name: PAWS_LABEL,
        color: "#5E6AD2",
        description: "Delegated to Paws",
        teamId,
      },
    });
    const payload = dig(data, ["issueLabelCreate"]);
    const created =
      payload === null ? null : readString(dig(payload, ["issueLabel"]) ?? {}, "name");
    if (payload?.["success"] === false || created === null) {
      stop(
        "Creating the Linear label paws failed. Check that the key can create labels on the team.",
      );
    }
  } catch (error) {
    if (error instanceof SetupStopped) throw error;
    stop(explainLinear(error, mode, "creating the paws label"));
  }
}

function linearClient(mode: LinearModeFlag, secret: string, fetchImpl?: SetupFetch): CommentQuery {
  if (mode === "comments") {
    return createPersonalLinearClient({
      apiKey: secret,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }
  return createLinearClient({
    auth: staticAuth(secret),
    ...(fetchImpl ? { fetch: asFetchLike(fetchImpl) } : {}),
  });
}

function staticAuth(token: string): LinearAuth {
  return {
    hasToken: () => true,
    ensureFresh: () => Promise.resolve(token),
    forceRefresh: () => Promise.resolve(token),
  };
}

function asFetchLike(fetchImpl: SetupFetch): FetchLike {
  return (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return fetchImpl(url, init);
  };
}

async function fetchTeams(client: CommentQuery): Promise<LinearTeam[]> {
  const data = await client.query(TEAMS);
  const nodes = dig(data, ["teams"])?.["nodes"];
  if (!Array.isArray(nodes))
    stop("Linear teams response was missing. Check the key and try again.");
  const teams: LinearTeam[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const id = readString(node, "id");
    const key = readString(node, "key");
    const name = readString(node, "name") ?? key;
    if (id === null || key === null || name === null) continue;
    teams.push({ id, key, name });
  }
  return teams;
}

async function fetchLabelNames(client: CommentQuery, teamId: string): Promise<string[]> {
  const data = await client.query(LABELS, { id: teamId });
  const nodes = dig(data, ["team", "labels"])?.["nodes"];
  if (!Array.isArray(nodes)) return [];
  const names: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const name = readString(node, "name");
    if (name !== null) names.push(name);
  }
  return names;
}

function requireTeam(teams: readonly LinearTeam[], wanted: string): LinearTeam {
  const match = teams.find(
    (team) =>
      team.id === wanted ||
      team.key.toLowerCase() === wanted.toLowerCase() ||
      team.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (match !== undefined) return match;
  const keys = teams.map((team) => team.key).join(", ");
  stop(`Linear team ${wanted} was not found. Pass --linear-team with one of: ${keys}.`);
}

function noTeams(mode: LinearModeFlag): string {
  if (mode === "comments") {
    return "The Linear key can see no teams. Check the key's access and try again.";
  }
  return "The Linear token can see no teams. Check the token's access and try again.";
}

function viewerMissing(mode: LinearModeFlag): string {
  if (mode === "comments") {
    return "Linear viewer response did not include an id. Check the API key and try again.";
  }
  return "Linear viewer response did not include an id. Check the access token and try again.";
}

function explainLinear(error: unknown, mode: LinearModeFlag, operation: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/401|unauthorized|authentication/i.test(message)) {
    return mode === "comments"
      ? "Linear rejected the API key. Create a personal API key in Linear settings and pass --linear-api-key."
      : "Linear rejected the access token. Pass a valid --linear-access-token.";
  }
  if (message.startsWith("Linear GraphQL")) {
    return `Linear request failed while ${operation}. ${message}`;
  }
  return mode === "comments"
    ? "Could not reach Linear to validate the API key. Check the network and try again."
    : "Could not reach Linear to validate the access token. Check the network and try again.";
}

function dig(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
