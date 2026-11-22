// Pure split-plan logic (cuts → parts → request), kept apart from the UI so it is tested directly.
import { PartInput, SplitRequest } from "./splitApi";

export interface PartMeta {
  name?: string;
  documentType?: string;
  employeeId?: string;
}

/** A cut at page n means a new part starts on page n (n > 1). */
export function partsFromCuts(pageCount: number, cuts: Iterable<number>): { from: number; to: number }[] {
  const starts = [1, ...Array.from(cuts).filter((n) => n > 1 && n <= pageCount)].sort((a, b) => a - b);
  const uniq = starts.filter((n, i) => starts.indexOf(n) === i);
  return uniq.map((from, i) => ({ from, to: (uniq[i + 1] ?? pageCount + 1) - 1 }));
}

/** Pages a part keeps once removed pages are dropped. */
export const keptPages = (p: { from: number; to: number }, removed: Set<number>) =>
  Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i).filter((n) => !removed.has(n));

/**
 * The request for POST /split. Parts whose pages are all removed are left out (their
 * pages are in `removed`, so nothing is lost). Metadata is keyed by the part's first page.
 */
export function buildRequest(
  pageCount: number,
  cuts: Iterable<number>,
  removed: Set<number>,
  rotations: Record<number, number>,
  meta: Record<number, PartMeta>,
  via: SplitRequest["via"]
): SplitRequest {
  const parts: PartInput[] = partsFromCuts(pageCount, cuts)
    .filter((p) => keptPages(p, removed).length > 0)
    .map((p) => {
      const m = meta[p.from] || {};
      const out: PartInput = { from: p.from, to: p.to };
      if (m.name?.trim()) out.name = m.name.trim();
      if (m.documentType) out.documentType = m.documentType;
      if (m.employeeId?.trim()) out.employeeId = m.employeeId.trim();
      return out;
    });
  const rot: Record<number, number> = {};
  for (const [k, v] of Object.entries(rotations)) if (v % 360 && !removed.has(Number(k))) rot[Number(k)] = ((v % 360) + 360) % 360;
  return { parts, removed: Array.from(removed).sort((a, b) => a - b), rotations: rot, via };
}
