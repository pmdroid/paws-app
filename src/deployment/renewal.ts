import { loadRunnerControl, loadRuntime, type EnvSource } from "../config";
import {
  certificateCovers,
  loadPublicTls,
  loadRunnerTls,
  publicTlsProxy,
  type PublicTls,
} from "./tls";

export const PUBLIC_TLS_RESTART_EXIT = 75;

export function validatePublicTls(source: EnvSource): PublicTls {
  if (source.PAWS_PUBLIC_DASHBOARD !== "1")
    throw new Error("Public HTTPS certificate validation requires the public dashboard.");
  const runtime = loadRuntime(source);
  if (runtime.configError !== null || runtime.publicUrl === null)
    throw new Error("Public HTTPS configuration is invalid.");
  return validatePublicTlsFiles({ ...source, PAWS_PUBLIC_URL: runtime.publicUrl });
}

/** Validate only the public URL and certificate pair, without loading runtime configuration. */
export function validatePublicTlsFiles(source: EnvSource): PublicTls {
  const url = new URL(source.PAWS_PUBLIC_URL!);
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
  if (!certificateCovers(tls.cert, url.href))
    throw new Error("Public HTTPS certificate does not match its hostname.");
  return tls;
}

export function validateTlsRenewal(source: EnvSource): void {
  const proxy = publicTlsProxy(source);
  const publicTls = proxy ? undefined : validatePublicTls(source);
  const control = loadRunnerControl(source, loadRuntime(source).env);
  if (control !== null) loadRunnerTls(control, publicTls, proxy);
}
