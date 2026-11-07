export const POSTGRES_NOT_YET =
  "Postgres is configured but Paws can't run on it yet; use `paws db check` to test the connection";

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

export function describeDatabaseUrl(value: string): string {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return `${url.host}/${database || "(default database)"}`;
}

export function redactDatabaseUrl(text: string, value: string): string {
  const url = new URL(value);
  const secrets = [value, url.password, decodeURIComponent(url.password)].filter(
    (secret) => secret.length > 0,
  );
  return secrets.reduce((out, secret) => out.split(secret).join("***"), text);
}
