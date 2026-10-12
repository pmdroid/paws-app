export const runtimeNativeFetch = fetch;

export const runtimeLinear = {
  active: true,
  reads: 0,
  slackReads: 0,
  installation: undefined as Promise<void> | undefined,
};

globalThis.fetch = Object.assign(
  async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === "https://slack.com" && url.pathname === "/api/users.lookupByEmail") {
      if (
        url.searchParams.get("email") !== "owner@example.invalid" ||
        new Headers(init?.headers).get("authorization") !== "Bearer fixture-slack-identity-token"
      )
        throw new Error("Unexpected scripted Slack lookup.");
      runtimeLinear.slackReads++;
      return Response.json({
        ok: true,
        user: {
          id: "U456",
          team_id: "T123",
          deleted: false,
          is_bot: false,
          is_app_user: false,
          profile: { email: "owner@example.invalid" },
        },
      });
    }
    if (String(input) === "https://api.linear.app/oauth/token")
      return Response.json({ access_token: "fixture-browser-token" });
    if (String(input) !== "https://api.linear.app/graphql")
      throw new Error("Only scripted Linear requests are available.");
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { id?: string };
    };
    if (body.query.includes("PawsBrowserIdentity"))
      return Response.json({
        data: {
          viewer: {
            id: "owner",
            app: false,
            name: "Owner",
            email: "owner@example.invalid",
            organization: { id: "org", name: "Local workspace" },
          },
        },
      });
    if (body.query.includes("PawsBrowserInstallation")) {
      await runtimeLinear.installation;
      if (process.env.PAWS_VERIFY_INSTALL_FAIL === "1")
        throw new Error("Scripted installation verification failure");
      return Response.json({
        data: {
          viewer: {
            app: process.env.PAWS_VERIFY_INSTALL_USER !== "1",
            organization: { id: "org", name: "Local workspace" },
          },
        },
      });
    }
    if (body.query.includes("PawsBrowserMembership")) {
      runtimeLinear.reads++;
      return Response.json({
        data: {
          viewer: { app: true, organization: { id: "org" } },
          user: {
            id: body.variables?.id,
            active: runtimeLinear.active,
            guest: false,
            admin: false,
            organization: { id: "org" },
            teams: {
              nodes: [{ id: "team" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    throw new Error("Unexpected scripted Linear query");
  },
  { preconnect: () => undefined },
);
