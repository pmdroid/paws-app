export function checkDatabaseUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error(`${field} must start with postgres:// or postgresql://`);
  if (url.hostname === "") throw new Error(`${field} must name a host`);
  return value;
}
