import axios from "axios";

export type DocTag = "processing" | "ready" | "needs_review" | "failed" | "restricted" | "duplicate" | "split_suggested" | "rescan";
export interface ScanDoc {
  fileId: string;
  fileName: string;
  status: string;
  stage: string | null;
  pages: number | null;
  fromPages: number[] | null;
  documentType: string | null;
  documentTypeName: string | null;
  person: string | null;
  confirmed: boolean;
  tags: DocTag[];
  reasons: string[];
  error: string;
}
export interface QcItem {
  fileId: string;
  fileName: string;
  result: "pass" | "fail" | null;
  note: string;
  by: string | null;
  at: string | null;
}
export interface QcSummary {
  percent: number;
  eligible: number;
  sampledAt: string;
  items: QcItem[];
  passed: number;
  failed: number;
  pending: number;
}
export interface ScanSummary {
  batch: { _id: string; name: string; boxId: string; expectedPages: number | null; splitMode: "separators" | "suggest" | "auto"; status: "open" | "processing" | "completed"; closedAt: string | null; completedAt: string | null; createdAt: string };
  pages: { expected: number | null; received: number; inDocuments: number; removed: number; unknown: number; missing: number | null };
  counts: Record<"received" | "documents" | DocTag, number>;
  pending: boolean;
  documents: ScanDoc[];
  byType: { label: string; documents: number }[];
  byPerson: { label: string; documents: number }[];
  qc: QcSummary | null;
}

export const startScanBatch = (body: { userId: string; name?: string; boxId?: string; expectedPages?: number; splitMode?: string }) =>
  axios.post("/api/batches/scan", body).then((r) => r.data as { _id: string });
export const getScanSummary = (id: string, userId: string) => axios.get(`/api/batches/${id}/scan`, { params: { userId } }).then((r) => r.data as ScanSummary);
export const sampleQc = (id: string, userId: string, percent?: number, replace = false) =>
  axios.post(`/api/batches/${id}/qc/sample`, { userId, percent, replace }).then((r) => r.data as QcSummary);
export const recordQc = (id: string, fileId: string, userId: string, result: "pass" | "fail", note = "") =>
  axios.post(`/api/batches/${id}/qc/${fileId}`, { userId, result, note }).then((r) => r.data as QcSummary);
export const getQcSettings = () => axios.get("/api/settings/qc").then((r) => r.data as { percent: number });

export async function downloadReconciliation(id: string, userId: string, format: "csv" | "pdf") {
  const r = await axios.get(`/api/batches/${id}/reconciliation.${format}`, { params: { userId }, responseType: "blob" });
  const disposition: string = r.headers["content-disposition"] || "";
  const name = decodeURIComponent(/filename="([^"]+)"/.exec(disposition)?.[1] || `reconciliation.${format}`);
  const url = URL.createObjectURL(r.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
