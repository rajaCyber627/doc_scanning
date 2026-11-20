import { closeBatch, createBatch, relativePath, BatchSummary } from "./batchApi";
import { getUploadConfig } from "../upload/uploadApi";
import { validateFile } from "../upload/uploader";
import { EnqueueTarget } from "../upload/useUploads";

type Enqueue = (files: File[], target?: string | EnqueueTarget) => Promise<void>;

/**
 * Upload many files as one tracked batch. Files that fail local checks (type/size)
 * are shown as failed in the tray and kept out of the batch, so the batch can finish.
 */
export async function startBatchUpload(
  enqueue: Enqueue,
  userId: string,
  files: File[],
  opts: { name?: string; folderId?: string } = {}
): Promise<BatchSummary | null> {
  const cfg = await getUploadConfig();
  const valid: File[] = [];
  const invalid: File[] = [];
  files.forEach((f) => (validateFile(f, cfg) ? invalid : valid).push(f));
  if (invalid.length) await enqueue(invalid); // listed in the tray with the reason
  if (!valid.length) return null;

  const batch = await createBatch({
    userId,
    name: opts.name?.trim() || undefined,
    folderId: opts.folderId,
    items: valid.map((f) => ({ name: f.name, size: f.size, path: relativePath(f) })),
  });
  await enqueue(valid, { folderId: opts.folderId, batchId: batch._id, batchItems: valid.map((_, i) => i) });
  // Every file is now known to the server; the batch completes when they all finish.
  await closeBatch(batch._id, userId);
  return batch;
}
