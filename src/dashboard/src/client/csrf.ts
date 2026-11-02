export function readCsrfToken(root: {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}): string {
  const meta = root.querySelector('meta[name="paws-csrf"]');
  const content = meta?.getAttribute("content");
  return content ?? "";
}
