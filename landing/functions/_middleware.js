export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname !== "get.paws.boo" || url.pathname !== "/") return context.next();
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const asset = new URL(url);
  asset.pathname = "/install.sh";
  const response = await context.env.ASSETS.fetch(new Request(asset, { method: "GET" }));
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "public, max-age=300");
  return new Response(response.body, { status: response.status, headers });
}
