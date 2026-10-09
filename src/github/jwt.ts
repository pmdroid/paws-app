import { createPrivateKey, createSign } from "node:crypto";

/**
 * GitHub App JWT. `exp` stays inside the 10 minute window GitHub allows.
 * `iat` is 30 seconds in the past so a small clock skew still validates.
 */
export function signAppJwt(appId: string, privateKeyPem: string, now: Date = new Date()): string {
  if (!/^\d+$/.test(appId)) throw new Error("app id must be numeric");
  const issued = Math.floor(now.getTime() / 1000) - 30;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: issued,
      exp: issued + 9 * 60,
      iss: appId,
    }),
  );
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString("base64url");
  return `${data}.${signature}`;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
