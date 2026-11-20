import { useCallback, useEffect, useRef, useState } from "react";
import { uploadFile, UploadCancelled, validateFile } from "./uploader";
import { getUploadConfig, UploadConfig } from "./uploadApi";

export type UploadPhase = "queued" | "uploading" | "verifying" | "done" | "failed" | "cancelled";

export interface UploadItem {
  id: string;
  file: File;
  folderId?: string;
  batchId?: string;
  batchItem?: number;
  progress: number; // 0..1
  phase: UploadPhase;
  error?: string;
  fileId?: string;
}

let seq = 0;

export interface EnqueueTarget {
  folderId?: string;
  batchId?: string;
  /** Batch item index for each file (same order as the files). */
  batchItems?: number[];
}

/**
 * Upload queue shared by the pages: per-file progress, cancel, retry.
 * `onUploaded` fires after each document is created (refresh the list then).
 *
 * The list lives in a ref (source of truth) mirrored into state for rendering, so
 * uploads are started exactly once even under React StrictMode.
 */
export function useUploads(userId: string, onUploaded?: () => void, { concurrency = 4 }: { concurrency?: number } = {}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(0);
  const mounted = useRef(true);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const commit = useCallback((next: UploadItem[]) => {
    itemsRef.current = next;
    if (mounted.current) setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, p: Partial<UploadItem>) => commit(itemsRef.current.map((it) => (it.id === id ? { ...it, ...p } : it))),
    [commit]
  );

  const startNext = useCallback(() => {
    const free = concurrency - running.current;
    if (free <= 0) return;
    const toStart = itemsRef.current.filter((it) => it.phase === "queued").slice(0, free);
    if (!toStart.length) return;
    const ids = new Set(toStart.map((t) => t.id));
    commit(itemsRef.current.map((it) => (ids.has(it.id) ? { ...it, phase: "uploading" as UploadPhase } : it)));

    toStart.forEach((it) => {
      running.current++;
      const ctrl = new AbortController();
      controllers.current.set(it.id, ctrl);
      uploadFile(it.file, {
        userId,
        folderId: it.folderId,
        batchId: it.batchId,
        batchItem: it.batchItem,
        signal: ctrl.signal,
        onProgress: (progress) => patch(it.id, { progress }),
        onPhase: (phase) => patch(it.id, { phase }),
      })
        .then((doc) => {
          patch(it.id, { phase: "done", progress: 1, fileId: doc?._id });
          onUploadedRef.current?.();
        })
        .catch((e) => {
          if (e instanceof UploadCancelled) patch(it.id, { phase: "cancelled" });
          else patch(it.id, { phase: "failed", error: e?.message || "Upload failed" });
        })
        .finally(() => {
          running.current--;
          controllers.current.delete(it.id);
          startNext();
        });
    });
  }, [userId, patch, commit, concurrency]);

  /** Add files; invalid ones are listed as failed right away with the reason. */
  const enqueue = useCallback(
    async (files: File[], target?: string | EnqueueTarget) => {
      const t: EnqueueTarget = typeof target === "string" ? { folderId: target } : target || {};
      if (!files.length) return;
      let cfg: UploadConfig | null = null;
      try {
        cfg = await getUploadConfig();
      } catch {
        /* server unreachable: each upload will report it */
      }
      const added: UploadItem[] = files.map((file, i) => {
        const invalid = cfg ? validateFile(file, cfg) : null;
        return {
          id: `u${++seq}`,
          file,
          folderId: t.folderId,
          batchId: t.batchId,
          batchItem: t.batchItems ? t.batchItems[i] : undefined,
          progress: 0,
          phase: invalid ? "failed" : "queued",
          error: invalid || undefined,
        };
      });
      commit([...itemsRef.current, ...added]);
      startNext();
    },
    [commit, startNext]
  );

  const cancel = useCallback(
    (id: string) => {
      const ctrl = controllers.current.get(id);
      if (ctrl) ctrl.abort();
      else patch(id, { phase: "cancelled" });
    },
    [patch]
  );

  const retry = useCallback(
    (id: string) => {
      patch(id, { phase: "queued", progress: 0, error: undefined });
      startNext();
    },
    [patch, startNext]
  );

  const dismiss = useCallback((id: string) => commit(itemsRef.current.filter((it) => it.id !== id)), [commit]);
  const clearFinished = useCallback(
    () => commit(itemsRef.current.filter((it) => !["done", "cancelled", "failed"].includes(it.phase))),
    [commit]
  );

  // Finished uploads leave the tray on their own after a few seconds.
  useEffect(() => {
    if (!items.some((it) => it.phase === "done" || it.phase === "cancelled")) return;
    const t = setTimeout(() => commit(itemsRef.current.filter((it) => it.phase !== "done" && it.phase !== "cancelled")), 4000);
    return () => clearTimeout(t);
  }, [items, commit]);

  // Stop in-flight uploads if the page unmounts.
  useEffect(() => {
    mounted.current = true;
    const map = controllers.current;
    return () => {
      mounted.current = false;
      map.forEach((c) => c.abort());
    };
  }, []);

  const busy = items.some((it) => ["queued", "uploading", "verifying"].includes(it.phase));
  return { items, enqueue, cancel, retry, dismiss, clearFinished, busy };
}
