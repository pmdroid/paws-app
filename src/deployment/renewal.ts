import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { loadRuntime, type EnvSource } from "../config";
import { loadPublicTls, type PublicTls } from "./tls";

export const PUBLIC_TLS_RESTART_EXIT = 75;

export function validatePublicTls(source: EnvSource): PublicTls {
  if (source.PAWS_PUBLIC_DASHBOARD !== "1")
    throw new Error("Public HTTPS certificate validation requires the public dashboard.");
  const runtime = loadRuntime(source);
  if (runtime.configError !== null || runtime.publicUrl === null)
    throw new Error("Public HTTPS configuration is invalid.");
  const url = new URL(runtime.publicUrl);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Public HTTPS configuration is invalid.");
  const tls = loadPublicTls(source)!;
  const certificate = new X509Certificate(tls.cert);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const matched = isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname);
  if (matched === undefined)
    throw new Error("Public HTTPS certificate does not match its hostname.");
  return tls;
}
