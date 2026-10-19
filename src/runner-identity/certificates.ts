import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readSecretFile, writeSecretFile } from "../credentials";

export type RunnerCertificate = {
  pem: string;
  fingerprint: string;
  serial: string;
  notBefore: number;
  notAfter: number;
};

export type RunnerAuthority = {
  certificate: string;
  fingerprint: string;
  issue(csr: string, lifetimeMs?: number, now?: number): Promise<RunnerCertificate>;
};

const AUTHORITY_FILE = "runner-authority.json";
const CLIENT_EXTENSIONS = `basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
`;

export async function initializeRunnerAuthority(root: string): Promise<RunnerAuthority> {
  privateDirectory(root);
  if (existsSync(join(root, AUTHORITY_FILE))) throw new Error("Runner authority already exists");
  await scratch(root, async (dir) => {
    await openssl(dir, [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "certificate.pem",
      "-days",
      "365",
      "-sha256",
      "-subj",
      "/CN=Paws Runner Authority",
      "-config",
      "/dev/null",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    writeSecretFile(
      join(root, AUTHORITY_FILE),
      JSON.stringify({
        key: readFileSync(join(dir, "key.pem"), "utf8"),
        certificate: readFileSync(join(dir, "certificate.pem"), "utf8"),
      }),
      true,
    );
  });
  return openRunnerAuthority(root);
}

export function openRunnerAuthority(root: string): RunnerAuthority {
  privateDirectory(root);
  const value: unknown = JSON.parse(readSecretFile(join(root, AUTHORITY_FILE)) ?? "null");
  if (
    value === null ||
    typeof value !== "object" ||
    !("key" in value) ||
    !("certificate" in value) ||
    typeof value.key !== "string" ||
    typeof value.certificate !== "string"
  )
    throw new Error("Runner authority is missing or invalid");
  const key = value.key;
  const pem = value.certificate;
  const certificate = new X509Certificate(pem);
  const publicKey = createPublicKey(createPrivateKey(key));
  if (!certificate.ca || !certificate.verify(publicKey) || !certificate.publicKey.equals(publicKey))
    throw new Error("Runner authority key and certificate do not match");
  return {
    certificate: pem,
    fingerprint: certificate.fingerprint256,
    async issue(csr, lifetimeMs = 24 * 60 * 60_000, now = Date.now()) {
      if (
        !Number.isSafeInteger(lifetimeMs) ||
        lifetimeMs < 60_000 ||
        lifetimeMs > 48 * 60 * 60_000 ||
        !Number.isSafeInteger(now) ||
        now < 0
      )
        throw new Error("Runner certificate lifetime is invalid");
      const notBefore = Math.max(now - 30_000, Date.parse(certificate.validFrom));
      const notAfter = now + lifetimeMs;
      if (
        Date.parse(certificate.validFrom) > notBefore ||
        Date.parse(certificate.validTo) < notAfter
      )
        throw new Error("Runner authority cannot cover the requested certificate lifetime");
      return scratch(root, async (dir) => {
        await validateRequest(dir, csr);
        privateFile(join(dir, "authority.key"), key);
        privateFile(join(dir, "authority.pem"), pem);
        privateFile(join(dir, "index.txt"), "");
        privateFile(join(dir, "serial"), `${randomBytes(16).toString("hex")}\n`);
        privateFile(join(dir, "client.ext"), CLIENT_EXTENSIONS);
        privateFile(
          join(dir, "ca.cnf"),
          `[ca]
default_ca=paws
[paws]
database=index.txt
serial=serial
new_certs_dir=.
certificate=authority.pem
private_key=authority.key
default_md=sha256
policy=subject_policy
unique_subject=no
copy_extensions=none
[subject_policy]
commonName=supplied
`,
        );
        await openssl(dir, [
          "ca",
          "-batch",
          "-notext",
          "-config",
          "ca.cnf",
          "-in",
          "request.pem",
          "-out",
          "certificate.pem",
          "-startdate",
          opensslDate(notBefore),
          "-enddate",
          opensslDate(notAfter),
          "-subj",
          "/CN=Paws Runner",
          "-extfile",
          "client.ext",
        ]);
        return describeRunnerCertificate(readFileSync(join(dir, "certificate.pem"), "utf8"));
      });
    },
  };
}

export async function createRunnerKey(root: string): Promise<{ csr: string; keyPath: string }> {
  privateDirectory(root);
  const keyPath = join(root, "runner-key.pem");
  if (existsSync(keyPath)) throw new Error("Runner private key already exists");
  return scratch(root, async (dir) => {
    await openssl(dir, [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "request.pem",
      "-sha256",
      "-subj",
      "/CN=Paws Runner",
      "-config",
      "/dev/null",
    ]);
    writeFileSync(keyPath, readFileSync(join(dir, "key.pem")), { flag: "wx", mode: 0o600 });
    return { csr: readFileSync(join(dir, "request.pem"), "utf8"), keyPath };
  });
}

export async function validateRunnerRequest(root: string, csr: string): Promise<void> {
  privateDirectory(root);
  await scratch(root, (dir) => validateRequest(dir, csr));
}

export function describeRunnerCertificate(pem: string): RunnerCertificate {
  const cert = new X509Certificate(pem);
  if (cert.ca || !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.2"))
    throw new Error("Certificate is not a runner client identity");
  return {
    pem,
    fingerprint: cert.fingerprint256,
    serial: cert.serialNumber,
    notBefore: Date.parse(cert.validFrom),
    notAfter: Date.parse(cert.validTo),
  };
}

async function validateRequest(dir: string, csr: string): Promise<void> {
  if (Buffer.byteLength(csr) > 16 * 1024 || !csr.startsWith("-----BEGIN CERTIFICATE REQUEST-----"))
    throw new Error("Invalid runner certificate request");
  privateFile(join(dir, "request.pem"), csr);
  const publicPem = await openssl(dir, [
    "req",
    "-in",
    "request.pem",
    "-verify",
    "-pubkey",
    "-noout",
  ]);
  const key = createPublicKey(publicPem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Runner certificate requests require a P-256 key");
}

async function scratch<T>(root: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(root, ".certificate-"));
  chmodSync(dir, 0o700);
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function privateDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
}

function privateFile(path: string, value: string): void {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function opensslDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "") + "Z";
}

async function openssl(cwd: string, args: string[]): Promise<string> {
  const binary = Bun.which("openssl", { PATH: "/usr/bin:/bin" });
  if (!binary) throw new Error("OpenSSL is required for runner certificates");
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: cwd },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [exit, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error("OpenSSL rejected the certificate operation");
    return output;
  } finally {
    clearTimeout(timeout);
  }
}
