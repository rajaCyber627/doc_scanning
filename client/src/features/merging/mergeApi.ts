import axios from "axios";

export interface ConflictValue {
  value: string;
  label: string;
  fileIds: string[];
}
export interface MergePreview {
  sources: { fileId: string; fileName: string; pageCount: number | null; confidentiality: string | null; documentType: string | null; employeeName: string | null }[];
  conflicts: { field: "person" | "documentType"; values: ConflictValue[] }[];
  agreed: { person: ConflictValue | null; documentType: ConflictValue | null };
  confidentiality: string | null;
  mixedRestricted: boolean;
}
export interface MergeItem {
  fileId: string;
  page: number;
  rotate: number;
}
export interface MergeRequest {
  pages: MergeItem[];
  name?: string;
  supersede?: boolean;
  resolution?: Record<string, string>;
  acknowledgeRestricted?: boolean;
}

export const previewMerge = (userId: string, fileIds: string[]) => axios.post("/api/merge/preview", { userId, fileIds }).then((r) => r.data as MergePreview);
export const mergeFiles = (userId: string, req: MergeRequest) =>
  axios.post("/api/merge", { userId, ...req }).then((r) => r.data as { fileId: string; fileName: string; pageCount: number; confidentiality: string | null });

/** Move item `from` to position `to` (drag-to-reorder). */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}
