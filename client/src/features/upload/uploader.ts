// Sends one file: ask the server for an upload target, send the bytes (direct to S3,
// in parallel parts for large files, or through the server), then ask the server to
// verify and create the document.
import {
  abortUpload,
  completeUpload,
  createUpload,
  getUploadConfig,
  UploadConfig,
  UploadTarget,
  errorMessage,
} from "./uploadApi";

export class UploadCancelled extends Error {}

/** Thrown when the browser cannot reach S3 at all (usually bucket CORS). */
class NetworkBlocked extends Error {}

const PROXY_FLAG = "docp.uploadTransport";
const PART_CONCURRENCY = 3;
const PART_ATTEMPTS = 3;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a part a few times (flaky networks); cancellation is never retried. */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof UploadCancelled || signal?.aborted || attempt === PART_ATTEMPTS) break;
      await wait(1000 * attempt);
    }
  }
  throw last;
}

export interface UploadOptions {
  userId: string;
  folderId?: string;
  batchId?: string;
  batchItem?: number;
  hints?: Record<string, string>;
  onProgress?: (fraction: number) => void;
  onPhase?: (phase: "uploading" | "verifying") => void;
  signal?: AbortSignal;
}

/** Local checks using the server's rules, so bad files are rejected before upload. */
export function validateFile(file: File, cfg: UploadConfig): string | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || "").toLowerCase();
  if (!cfg.acceptedTypes.some((t) => t.ext === ext)) {
    return `"${file.name}" is not a supported file type. Accepted: ${cfg.accept.replace(/,/g, ", ")}`;
  }
  if (file.size === 0) return `"${file.name}" is empty`;
  if (file.size > cfg.maxBytes) {
    return `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${Math.round(cfg.maxBytes / 1048576)} MB`;
  }
  return null;
}

function preferProxy(cfg: UploadConfig): boolean {
  if (cfg.transport === "proxy") return true;
  if (cfg.transport === "direct") return false;
  try {
    return sessionStorage.getItem(PROXY_FLAG) === "proxy";
  } catch {
    return false;
  }
}

function rememberProxy() {
  try {
    sessionStorage.setItem(PROXY_FLAG, "proxy");
  } catch {
    /* storage unavailable — fine, we just retry direct next time */
  }
}

/** PUT a body with progress. Resolves with the ETag header (if exposed). */
function put(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.getResponseHeader("ETag"));
      let msg = `Storage rejected the upload (HTTP ${xhr.status})`;
      try {
        const j = JSON.parse(xhr.responseText);
        if (j.message) msg = j.message;
      } catch {
        /* not JSON (e.g. S3 XML) */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new NetworkBlocked("Could not reach storage"));
    xhr.onabort = () => reject(new UploadCancelled("Upload cancelled"));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

async function sendBytes(file: File, t: UploadTarget, opts: UploadOptions, proxyQuery: string) {
  const report = (loaded: number) => opts.onProgress?.(Math.min(1, loaded / file.size));

  if (t.transport === "proxy") {
    await put(`${t.proxyUrl}${proxyQuery}`, file, { "Content-Type": "application/octet-stream" }, report, opts.signal);
    return undefined;
  }
  if (t.url) {
    await put(t.url, file, { "Content-Type": t.contentType }, report, opts.signal);
    return undefined;
  }

  // Multipart: upload parts in parallel, track combined progress.
  const { partSizeBytes, parts } = t.multipart!;
  const loaded = new Map<number, number>();
  const done: { PartNumber: number; ETag: string }[] = [];
  const queue = [...parts];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift()!;
      const blob = file.slice((p.partNumber - 1) * partSizeBytes, p.partNumber * partSizeBytes);
      const etag = await withRetry(
        () =>
          put(
            p.url,
            blob,
            {},
            (n) => {
              loaded.set(p.partNumber, n);
              report(Array.from(loaded.values()).reduce((a, b) => a + b, 0));
            },
            opts.signal
          ),
        opts.signal
      );
      if (!etag) throw new Error("Storage did not return the part checksum (ETag). Ask IT to expose the ETag header in the bucket CORS settings.");
      done.push({ PartNumber: p.partNumber, ETag: etag });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, worker));
  return done;
}

/** Upload one file end to end. Resolves with the created document. */
export async function uploadFile(file: File, opts: UploadOptions) {
  const cfg = await getUploadConfig();
  const invalid = validateFile(file, cfg);
  if (invalid) throw new Error(invalid);

  const attempt = async (transport: "direct" | "proxy") => {
    let target: UploadTarget;
    try {
      target = await createUpload({
        userId: opts.userId,
        fileName: file.name,
        sizeBytes: file.size,
        folderId: opts.folderId,
        batchId: opts.batchId,
        batchItem: opts.batchItem,
        hints: opts.hints,
        transport,
      });
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    opts.onPhase?.("uploading");
    try {
      const parts = await sendBytes(file, target, opts, `?userId=${encodeURIComponent(opts.userId)}`);
      opts.onPhase?.("verifying");
      return await completeUpload(target.uploadId, opts.userId, parts);
    } catch (e: any) {
      if (!(e instanceof UploadCancelled) && !(e instanceof NetworkBlocked) && e?.response) {
        throw new Error(errorMessage(e)); // server verification failed — session already closed
      }
      await abortUpload(target.uploadId, opts.userId, e?.message || "failed");
      throw e;
    }
  };

  const first: "direct" | "proxy" = preferProxy(cfg) ? "proxy" : "direct";
  try {
    return await attempt(first);
  } catch (e) {
    // The bucket blocks browser uploads (no CORS rule): fall back to the server.
    if (e instanceof NetworkBlocked && first === "direct" && cfg.transport === "auto") {
      rememberProxy();
      opts.onProgress?.(0);
      return attempt("proxy");
    }
    if (e instanceof NetworkBlocked) throw new Error("Could not reach the server — check your connection and try again");
    throw e;
  }
}
