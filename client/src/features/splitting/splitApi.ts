import axios from "axios";

export interface PageInfo {
  page: number;
  wordCount: number;
  blank: boolean;
  snippet: string;
  separator: { via: "qr" | "text" | "blank"; prefill: { documentType?: string; employeeId?: string } } | null;
}
export interface SuggestedPart {
  from: number;
  to: number;
  documentType: string | null;
  reason: string;
  confidence: number;
}
export interface Suggestion {
  cuts: { page: number; reason: string; confidence: number }[];
  parts: SuggestedPart[];
  model?: string;
}
export interface PagesInfo {
  fileId: string;
  pageCount: number;
  source: "original" | "rendition";
  splittable: boolean;
  reason: string | null;
  pages: PageInfo[];
  separatorParts: { from: number; to: number; prefill: { documentType?: string; employeeId?: string } }[];
  suggestion: Suggestion | null;
  splitInto: string[];
  splitFrom: { fileId: string; part: number; pages: number[] } | null;
}
export interface PartInput {
  from: number;
  to: number;
  name?: string;
  documentType?: string;
  employeeId?: string;
}
export interface SplitRequest {
  parts: PartInput[];
  removed: number[];
  rotations: Record<number, number>;
  via: "manual" | "ai" | "separator";
}

export const getPages = (fileId: string, userId: string) =>
  axios.get(`/api/files/${fileId}/pages`, { params: { userId } }).then((r) => r.data as PagesInfo);
export const getPagesPdf = (fileId: string, userId: string) =>
  axios.get(`/api/files/${fileId}/pages.pdf`, { params: { userId }, responseType: "blob" }).then((r) => r.data as Blob);
export const suggestSplit = (fileId: string, userId: string) =>
  axios.post(`/api/files/${fileId}/split/suggest`, { userId }).then((r) => r.data as Suggestion);
export const splitFile = (fileId: string, userId: string, req: SplitRequest) =>
  axios.post(`/api/files/${fileId}/split`, { userId, ...req }).then((r) => r.data as { splitId: string; parts: { fileId: string; fileName: string; pages: number[] }[] });
export const getSeparatorSheet = (params: { documentType?: string; employeeId?: string; copies?: number }) =>
  axios.get("/api/separator-sheet.pdf", { params, responseType: "blob" }).then((r) => r.data as Blob);
