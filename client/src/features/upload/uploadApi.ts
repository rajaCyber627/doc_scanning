import axios from "axios";

export interface AcceptedType {
  ext: string;
  mime: string;
  kind: string;
  label: string;
}

export interface UploadConfig {
  maxBytes: number;
  multipartThresholdBytes: number;
  partSizeBytes: number;
  transport: "auto" | "direct" | "proxy";
  acceptedTypes: AcceptedType[];
  accept: string; // ".pdf,.png,..." for <input accept>
}

export interface UploadTarget {
  uploadId: string;
  transport: "direct" | "proxy";
  contentType: string;
  url?: string;
  proxyUrl?: string;
  multipart?: { partSizeBytes: number; parts: { partNumber: number; url: string }[] };
}

let configPromise: Promise<UploadConfig> | null = null;

/** Accepted types and limits come from the server (cached for the session). */
export function getUploadConfig(): Promise<UploadConfig> {
  if (!configPromise) {
    configPromise = axios
      .get("/api/uploads/config")
      .then((r) => r.data as UploadConfig)
      .catch((e) => {
        configPromise = null;
        throw e;
      });
  }
  return configPromise;
}

export const createUpload = (body: {
  userId: string;
  fileName: string;
  sizeBytes: number;
  folderId?: string;
  batchId?: string;
  batchItem?: number;
  transport?: "direct" | "proxy";
  hints?: Record<string, string>;
}) => axios.post("/api/uploads", body).then((r) => r.data as UploadTarget);

export const completeUpload = (uploadId: string, userId: string, parts?: { PartNumber: number; ETag: string }[]) =>
  axios.post(`/api/uploads/${uploadId}/complete`, { userId, parts }).then((r) => r.data.file);

export const abortUpload = (uploadId: string, userId: string, reason: string) =>
  axios.post(`/api/uploads/${uploadId}/abort`, { userId, reason }).catch(() => undefined);

export const retryDocument = (fileId: string, userId: string) =>
  axios.post(`/api/files/${fileId}/retry`, { userId }).then((r) => r.data.file);

/** Readable message from an axios error (server sends { message }). */
export function errorMessage(e: any, fallback = "Upload failed"): string {
  return e?.response?.data?.message || e?.message || fallback;
}
