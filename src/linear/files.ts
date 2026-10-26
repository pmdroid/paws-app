import { LinearHttpError } from "./graphql";
import { journalCaught } from "../journal";
import type { LinearClient } from "./graphql";
import type { FetchLike, LinearAuth } from "./oauth";
import { isRecord, readString } from "./read";

export type LinearFileMetadata = {
  filename: string;
  contentType: string;
  size: number;
};

export type UploadedLinearFile = LinearFileMetadata & { assetUrl: string };
export type PreparedLinearUpload = LinearFileMetadata & {
  uploadUrl: string;
  assetUrl: string;
  headers: { key: string; value: string }[];
};
export type DownloadedLinearFile = LinearFileMetadata & { bytes: Uint8Array };

export type LinearFileTransfer = {
  prepareUpload(
    input: LinearFileMetadata & { signal?: AbortSignal },
  ): Promise<PreparedLinearUpload>;
  uploadPrepared(input: {
    upload: PreparedLinearUpload;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<UploadedLinearFile>;
  upload(input: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<UploadedLinearFile>;
  download(input: {
    url: string;
    filename?: string;
    signal?: AbortSignal;
  }): Promise<DownloadedLinearFile>;
};

const UPLOAD_MUTATION = `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!, $makePublic: Boolean!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size, makePublic: $makePublic) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

export function createLinearFileTransfer(options: {
  client: LinearClient;
  auth: Pick<LinearAuth, "ensureFresh">;
  fetch?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
}): LinearFileTransfer {
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_147_483_647) {
    throw new Error("Linear file size limit must be a positive 32-bit integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Linear file timeout must be a positive integer");
  }
  function validateMetadata(input: LinearFileMetadata): void {
    validateFilename(input.filename);
    validateContentType(input.contentType);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxBytes) {
      throw new Error("Linear file exceeds the byte limit");
    }
  }
  async function prepare(
    metadata: LinearFileMetadata,
    signal: AbortSignal,
  ): Promise<PreparedLinearUpload> {
    const data = await abortable(
      options.client.query(UPLOAD_MUTATION, { ...metadata, makePublic: false }, { signal }),
      signal,
    );
    return { ...metadata, ...preparedUpload(data) };
  }
  async function put(
    upload: PreparedLinearUpload,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<UploadedLinearFile> {
    const headers = new Headers({ "content-type": upload.contentType });
    try {
      for (const header of upload.headers) headers.set(header.key, header.value);
    } catch {
      throw new Error("Linear fileUpload returned invalid upload headers");
    }
    signal.throwIfAborted();
    const response = await fetchFile(
      fetchImpl,
      upload.uploadUrl,
      { method: "PUT", headers, body: bytes, redirect: "error", signal },
      signal,
      "upload",
    );
    discardBody(response);
    if (!response.ok)
      throw new LinearHttpError(
        response.status,
        "",
        response.headers,
        Date.now(),
        `Linear file upload HTTP ${response.status}`,
      );
    if (response.redirected) throw new Error("Linear file upload redirects are forbidden");
    return {
      assetUrl: upload.assetUrl,
      filename: upload.filename,
      contentType: upload.contentType,
      size: upload.size,
    };
  }
  return {
    async prepareUpload(input) {
      const metadata = {
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
      };
      validateMetadata(metadata);
      return transfer(input.signal, timeoutMs, (signal) => prepare(metadata, signal));
    },
    async uploadPrepared(input) {
      const metadata = {
        filename: input.upload.filename,
        contentType: input.upload.contentType,
        size: input.upload.size,
      };
      validateMetadata(metadata);
      if (input.bytes.byteLength !== metadata.size) {
        throw new Error("Linear prepared upload byte length does not match");
      }
      const destination = preparedUpload({
        fileUpload: { success: true, uploadFile: input.upload },
      });
      const upload = { ...metadata, ...destination };
      const bytes = new Uint8Array(input.bytes);
      return transfer(input.signal, timeoutMs, (signal) => put(upload, bytes, signal));
    },
    async upload(input) {
      const metadata = {
        filename: input.filename,
        contentType: input.contentType,
        size: input.bytes.byteLength,
      };
      validateMetadata(metadata);
      const bytes = new Uint8Array(input.bytes);
      return transfer(input.signal, timeoutMs, async (signal) => {
        const upload = await prepare(metadata, signal);
        return put(upload, bytes, signal);
      });
    },
    async download(input) {
      const url = privateFileUrl(input.url);
      const filename = input.filename ?? filenameFromUrl(url);
      validateFilename(filename);
      return transfer(input.signal, timeoutMs, async (signal) => {
        const token = await abortable(options.auth.ensureFresh(), signal);
        signal.throwIfAborted();
        const response = await fetchFile(
          fetchImpl,
          url,
          {
            method: "GET",
            headers: { authorization: `Bearer ${token}` },
            redirect: "error",
            signal,
          },
          signal,
          "download",
        );
        if (!response.ok) {
          discardBody(response);
          throw new LinearHttpError(
            response.status,
            "",
            response.headers,
            Date.now(),
            `Linear file download HTTP ${response.status}`,
          );
        }
        if (response.redirected) {
          discardBody(response);
          throw new Error("Linear file download redirects are forbidden");
        }
        const contentType =
          response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
        try {
          validateContentType(contentType);
        } catch (error) {
          discardBody(response);
          throw error;
        }
        const bytes = await readBytes(response, maxBytes, signal);
        return { filename, contentType, bytes, size: bytes.byteLength };
      });
    },
  };
}

function preparedUpload(data: unknown): {
  uploadUrl: string;
  assetUrl: string;
  headers: { key: string; value: string }[];
} {
  const payload = isRecord(data) && isRecord(data["fileUpload"]) ? data["fileUpload"] : null;
  const file =
    payload?.["success"] === true && isRecord(payload["uploadFile"]) ? payload["uploadFile"] : null;
  const uploadUrl = file === null ? null : readString(file, "uploadUrl");
  const assetUrl = file === null ? null : readString(file, "assetUrl");
  if (file === null || uploadUrl === null || assetUrl === null || !Array.isArray(file["headers"])) {
    throw new Error("Linear fileUpload returned no valid upload destination");
  }
  const target = parseUrl(uploadUrl);
  if (target.protocol !== "https:" || target.username || target.password || target.hash) {
    throw new Error("Linear file upload requires an HTTPS destination without credentials");
  }
  privateFileUrl(assetUrl);
  const headers = file["headers"].map((header: unknown) => {
    if (
      !isRecord(header) ||
      typeof header["key"] !== "string" ||
      typeof header["value"] !== "string"
    ) {
      throw new Error("Linear fileUpload returned invalid upload headers");
    }
    return { key: header["key"], value: header["value"] };
  });
  return { uploadUrl, assetUrl, headers };
}

function privateFileUrl(value: string): URL {
  const url = parseUrl(value);
  if (url.origin !== "https://uploads.linear.app" || url.username || url.password || url.hash) {
    throw new Error("Linear private files require the exact HTTPS uploads.linear.app origin");
  }
  return url;
}

function filenameFromUrl(url: URL): string {
  let filename: string;
  try {
    filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  } catch (caughtError1) {
    journalCaught(caughtError1, "files.filenameFromUrl.decodeURIComponent", null);
    filename = "download";
  }
  return (
    filename
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 180) || "download"
  );
}

function validateFilename(filename: string): void {
  if (
    !filename.trim() ||
    filename.length > 255 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    [...filename].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /^\.+$/.test(filename)
  ) {
    throw new Error("Linear file requires a safe filename without paths or control characters");
  }
}

function validateContentType(contentType: string): void {
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType)) {
    throw new Error("Linear file requires a valid MIME type");
  }
}

async function readBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    discardBody(response);
    throw new Error("Linear file exceeds the byte limit");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await abortable(reader.read(), signal);
      } catch {
        signal.throwIfAborted();
        throw new Error("Linear file download body could not be read");
      }
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new Error("Linear file exceeds the byte limit");
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "files.readBytes.cancel", null);
    });
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch((caughtError3) => {
    journalCaught(caughtError3, "files.discardBody.cancel", null);
  });
}

async function transfer<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Linear file transfer timed out")),
    timeoutMs,
  );
  try {
    if (parent?.aborted) stop();
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", stop);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      void promise.catch((caughtError4) => {
        journalCaught(caughtError4, "files.abortable", null);
      });
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function fetchFile(
  fetchImpl: FetchLike,
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal,
  operation: "upload" | "download",
): Promise<Response> {
  try {
    return await abortable(
      fetchImpl(url, init).then((response) => {
        if (signal.aborted) discardBody(response);
        return response;
      }),
      signal,
    );
  } catch {
    signal.throwIfAborted();
    throw new Error(`Linear file ${operation} request failed`);
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Linear file destination URL is invalid");
  }
}
