import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

export type LinearAttributionContext = {
  issueId: string;
  organizationId: string;
  teamId: string;
  projectId: string | null;
  leadId: string | null;
};

export function createLinearAttributionReads(client: LinearClient) {
  return {
    async getIssueAttribution(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<LinearAttributionContext> {
      const data = await client.query(
        `query PawsIssueAttribution($id: String!) {
        viewer { app organization { id } }
        issue(id: $id) { id team { id } project { id lead { id app active } } }
      }`,
        { id: issueId },
        options,
      );
      const viewer = isRecord(data) ? data["viewer"] : null;
      const organization = isRecord(viewer) ? viewer["organization"] : null;
      const issue = isRecord(data) ? data["issue"] : null;
      const team = isRecord(issue) ? issue["team"] : null;
      if (
        !isRecord(viewer) ||
        viewer["app"] !== true ||
        !isRecord(organization) ||
        !readString(organization, "id") ||
        !isRecord(issue) ||
        issue["id"] !== issueId ||
        !isRecord(team) ||
        !readString(team, "id")
      )
        throw new Error("Linear attribution ownership could not be verified.");
      const project = issue["project"];
      if (project !== null && (!isRecord(project) || !readString(project, "id")))
        throw new Error("Linear project could not be verified.");
      const lead = isRecord(project) ? project["lead"] : null;
      if (
        lead !== null &&
        (!isRecord(lead) ||
          !readString(lead, "id") ||
          lead["app"] !== false ||
          lead["active"] !== true)
      )
        throw new Error("An active human Linear project lead is required.");
      return {
        issueId,
        organizationId: readString(organization, "id")!,
        teamId: readString(team, "id")!,
        projectId: isRecord(project) ? readString(project, "id")! : null,
        leadId: isRecord(lead) ? readString(lead, "id")! : null,
      };
    },
  };
}
