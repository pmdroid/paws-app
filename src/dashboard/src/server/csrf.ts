let processToken: string | null = null;

/** One CSRF token for this process. The status page embeds it. */
export function processCsrfToken(): string {
  processToken ??= crypto.randomUUID();
  return processToken;
}

export function injectCsrf(html: string, token: string = processCsrfToken()): string {
  if (html.includes('name="paws-csrf"')) return html;
  const meta = `<meta name="paws-csrf" content="${token}" />`;
  if (html.includes("<head>")) return html.replace("<head>", `<head>\n    ${meta}`);
  return `${meta}\n${html}`;
}
