import axios from "axios";

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "fiscalyear" | "select" | "person" | "doctype";
  required?: boolean;
  options?: string[];
  help?: string;
}
export interface Category {
  key: string;
  name: string;
  hrFunctionalArea: string;
  defaultConfidentiality: string;
  defaultRetentionCategory: string;
  order: number;
}
export interface DocType {
  key: string;
  name: string;
  categoryKey: string;
  defaultConfidentiality: string;
  defaultRetentionCategory: string;
  fields: FieldDef[];
  active: boolean;
  order: number;
}
export interface Taxonomy {
  categories: Category[];
  documentTypes: DocType[];
  baseFields: FieldDef[];
  personFields: string[];
  confidentialityLevels: string[];
  fiscalYearStartMonth: number;
}
export interface Person {
  personId: string;
  type: string;
  name: string;
  employeeId: string | null;
  applicantNumber: string | null;
  positionTitle: string;
  department: string;
  division: string | null;
  status: string;
}
export type Metadata = Record<string, any>;
export interface FieldError {
  field: string;
  message: string;
}

let taxonomyPromise: Promise<Taxonomy> | null = null;
export function getTaxonomy(force = false): Promise<Taxonomy> {
  if (!taxonomyPromise || force) {
    taxonomyPromise = axios
      .get("/api/taxonomy")
      .then((r) => r.data as Taxonomy)
      .catch((e) => {
        taxonomyPromise = null;
        throw e;
      });
  }
  return taxonomyPromise;
}

/** Base fields with the type's fields merged in (type wins), like the server. */
export function fieldsFor(tax: Taxonomy, typeKey?: string): FieldDef[] {
  const type = tax.documentTypes.find((t) => t.key === typeKey);
  const merged = new Map(tax.baseFields.map((f) => [f.key, { ...f }]));
  for (const f of type?.fields || []) merged.set(f.key, { ...(merged.get(f.key) || {}), ...f });
  return Array.from(merged.values());
}

export const lookupPeople = (q: string) => axios.get("/api/people", { params: { q } }).then((r) => r.data as Person[]);

export const saveMetadata = (fileId: string, userId: string, metadata: Metadata) =>
  axios
    .put(`/api/files/${fileId}/metadata`, { userId, metadata })
    .then((r) => r.data as { metadata: Metadata; metadataStatus: string; errors: FieldError[] });

export interface BulkResult {
  fileId: string;
  fileName?: string;
  changes?: { field: string; from: any; to: any }[];
  errors?: FieldError[];
  error?: string;
  metadataStatus?: string;
}
export const bulkMetadata = (userId: string, fileIds: string[], set: Metadata, apply: boolean) =>
  axios.post("/api/metadata/bulk", { userId, fileIds, set, apply }).then((r) => r.data as { applied: boolean; results: BulkResult[] });

export const nextIncomplete = (userId: string, after: string) =>
  axios.get("/api/metadata/next", { params: { userId, after } }).then((r) => r.data as { fileId: string; fileName: string } | null);

export const saveDocumentType = (userId: string, type: DocType) =>
  axios.put(`/api/taxonomy/document-types/${encodeURIComponent(type.key)}`, { userId, type }).then((r) => r.data as DocType);

export const exportTaxonomy = () => axios.get("/api/taxonomy/export").then((r) => r.data);

export const importTaxonomy = (userId: string, data: unknown, mode: "merge" | "replace") =>
  axios.post("/api/taxonomy/import", { userId, data, mode }).then((r) => r.data);
