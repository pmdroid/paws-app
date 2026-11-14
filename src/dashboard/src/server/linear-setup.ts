export function linearSetupPage(origin: string, token: string): Response {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Linear · Paws</title>
<style>
:root{color-scheme:light dark;font:16px system-ui;background:light-dark(#e8e0f0,#241e2c);color:light-dark(#211c25,#f5f0fa)}
*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:560px;margin:0 auto;padding:28px;background:light-dark(#fffdf7,#302737);border:2px solid;border-radius:5px;box-shadow:4px 4px 0}
h1{margin-top:0}p{line-height:1.5}code{display:block;overflow-wrap:anywhere;margin:8px 0 20px}
label{display:block;font-weight:600;margin:20px 0 8px}input,button{font:inherit;min-height:44px;border:2px solid;border-radius:5px;width:100%;padding:10px}
button{margin-top:24px;background:#ff9955;color:#211c25;font-weight:700;cursor:pointer}input:focus-visible,button:focus-visible{outline:3px solid #8753c7;outline-offset:3px}
</style><main><h1>Connect Linear</h1><p>Create a Linear OAuth app, then paste these URLs into its settings.</p>
<p>Redirect URLs</p><code>${escape(origin)}/auth/linear/callback<br>${escape(origin)}/auth/linear/install/callback</code>
<p>Webhook URL</p><code>${escape(origin)}/webhooks/linear</code>
<form method="post" action="/setup?token=${escape(token)}">
<label for="clientId">Client ID</label><input id="clientId" name="clientId" required maxlength="4096" autocomplete="off">
<label for="clientSecret">Client secret</label><input id="clientSecret" name="clientSecret" type="password" required maxlength="4096" autocomplete="off">
<label for="webhookSecret">Webhook signing secret</label><input id="webhookSecret" name="webhookSecret" type="password" required maxlength="4096" autocomplete="off">
<button>Save and sign in with Linear</button></form><p>Sign in as a Linear workspace admin to continue.</p></main></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}
