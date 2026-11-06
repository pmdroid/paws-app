import type { WorkspacePrincipal } from "../workspace";

const RETIRED = /^\/api\/runners\/accounts(?:\/.*)?$/;

export const AGENT_ACCOUNTS_RETIRED =
  "Agent accounts were replaced by per-runner sign-in on the Runners page";

export function createAccountManagement() {
  return async function browser(
    request: Request,
    _principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    if (!RETIRED.test(new URL(request.url).pathname)) return null;
    return Response.json(
      { error: AGENT_ACCOUNTS_RETIRED },
      { status: 410, headers: { "cache-control": "no-store" } },
    );
  };
}
