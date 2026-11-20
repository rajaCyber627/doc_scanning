import axios from "axios";

export type ItemState =
  | "not_uploaded"
  | "uploading"
  | "upload_failed"
  | "processing"
  | "ready"
  | "needs_review"
  | "failed"
  | "cancelled";

export interface BatchCounts {
  total: number;
  uploaded: number;
  uploading: number;
  processing: number;
  ready: number;
  needsReview: number;
  failed: number;
  uploadFailed: number;
  notUploaded: number;
  cancelled: number;
}

export interface BatchSummary {
  _id: string;
  name: string;
  source: string;
  folderId: string | null;
  status: "open" | "processing" | "completed";
  counts: BatchCounts;
  itemCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface BatchItemRow {
  index: number | null;
  name: string;
  size: number;
  path: string;
  state: ItemState;
  stage: string | null;
  error: string;
  documentId: string | null;
  uploadedAt: string | null;
}

export const createBatch = (body: {
  userId: string;
  name?: string;
  folderId?: string;
  items: { name: string; size: number; path?: string }[];
}) => axios.post("/api/batches", body).then((r) => r.data as BatchSummary);

export const listBatches = (userId: string) =>
  axios.get("/api/batches", { params: { userId } }).then((r) => r.data as BatchSummary[]);

export const getBatch = (id: string, userId: string) =>
  axios.get(`/api/batches/${id}`, { params: { userId } }).then((r) => r.data as { batch: BatchSummary; items: BatchItemRow[] });

export const closeBatch = (id: string, userId: string) => axios.post(`/api/batches/${id}/close`, { userId }).then((r) => r.data);

export const retryFailedInBatch = (id: string, userId: string) =>
  axios.post(`/api/batches/${id}/retry-failed`, { userId }).then((r) => r.data as { retried: number });

export const cancelUnfinished = (id: string, userId: string, indexes?: number[]) =>
  axios.post(`/api/batches/${id}/cancel-unfinished`, { userId, indexes }).then((r) => r.data as { cancelled: number });

/** Download the batch CSV report (fetched via the API so it works behind any proxy). */
export async function downloadBatchReport(id: string, userId: string, fallbackName = "batch-report.csv") {
  const r = await axios.get(`/api/batches/${id}/report.csv`, { params: { userId }, responseType: "blob" });
  const disposition: string = r.headers["content-disposition"] || "";
  const name = decodeURIComponent(/filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName);
  const url = URL.createObjectURL(r.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Relative folder path of a picked/dropped file ("" for plain files). */
export function relativePath(file: File): string {
  const f = file as File & { path?: string; webkitRelativePath?: string };
  const p = f.webkitRelativePath || f.path || "";
  return p.replace(/^\/+/, "");
}
