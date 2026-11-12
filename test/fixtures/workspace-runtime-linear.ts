export const runtimeNativeFetch = fetch;

export const runtimeLinear = {
  active: true,
  reads: 0,
  installation: undefined as Promise<void> | undefined,
  graph: undefined as
    | ((query: string, variables: Record<string, unknown>) => Response | Promise<Response>)
    | undefined,
};

globalThis.fetch = Object.assign(
  async (input: unknown, init?: RequestInit) => {
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
    if (runtimeLinear.graph) return runtimeLinear.graph(body.query, body.variables ?? {});
    throw new Error("Unexpected scripted Linear query");
  },
  { preconnect: () => undefined },
);
