import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { message } from "antd";
import dayjs from "dayjs";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { deleteFile } from "../../api";
import { useUploads } from "../upload/useUploads";
import UploadTray from "../upload/UploadTray";
import { errorMessage } from "../upload/uploadApi";
import ItemStateBadge from "./ItemStateBadge";
import {
  getBatch,
  retryFailedInBatch,
  cancelUnfinished,
  downloadBatchReport,
  BatchSummary,
  BatchItemRow,
} from "./batchApi";

const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const UNFINISHED = new Set(["not_uploaded", "uploading", "upload_failed"]);
const STATUS_LABEL = { open: "Uploading", processing: "Processing", completed: "Completed" } as const;

/** One batch: totals, every file's status, retry / resume / cancel, CSV report. */
export default function BatchPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const user = getUser()!;
  const [data, setData] = useState<{ batch: BatchSummary; items: BatchItemRow[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const resumeRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!id) return;
    getBatch(id, user._id)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errorMessage(e, "Could not load this batch")));
  }, [id, user._id]);
  useEffect(load, [load]);

  const uploads = useUploads(user._id, load);
  const active = data && (data.batch.status !== "completed" || uploads.busy);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  const unfinished = useMemo(() => (data ? data.items.filter((i) => i.index !== null && UNFINISHED.has(i.state)) : []), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    return filter === "all" ? data.items : data.items.filter((i) => ["failed", "upload_failed", "needs_review", "not_uploaded"].includes(i.state));
  }, [data, filter]);

  if (error && !data)
    return (
      <AppShell>
        <div className="card" style={{ padding: 24, color: "var(--danger)" }}>{error}</div>
      </AppShell>
    );
  if (!data)
    return (
      <AppShell>
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      </AppShell>
    );

  const { batch } = data;
  const c = batch.counts;
  const failedDocs = c.failed;

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      message.success(await fn());
      load();
    } catch (e) {
      message.error(errorMessage(e, "That did not work — please try again"));
    } finally {
      setBusy("");
    }
  };

  // Resume after a refresh: re-select the original files; matched by name + size.
  const onResumePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    const matchedFiles: File[] = [];
    const indexes: number[] = [];
    const taken = new Set<number>();
    for (const f of picked) {
      const row = unfinished.find((u) => u.name === f.name && u.size === f.size && !taken.has(u.index!));
      if (row) {
        taken.add(row.index!);
        matchedFiles.push(f);
        indexes.push(row.index!);
      }
    }
    const skipped = picked.length - matchedFiles.length;
    if (!matchedFiles.length) {
      message.warning("None of those files match the unfinished files in this batch (same name and size).");
      return;
    }
    uploads.enqueue(matchedFiles, { folderId: batch.folderId || undefined, batchId: batch._id, batchItems: indexes });
    message.info(`Resuming ${matchedFiles.length} file${matchedFiles.length > 1 ? "s" : ""}${skipped ? ` · ${skipped} not part of this batch` : ""}`);
  };

  const remove = async (row: BatchItemRow) => {
    if (!row.documentId || !window.confirm(`Remove "${row.name}" from your documents?`)) return;
    try {
      await deleteFile(row.documentId);
      load();
    } catch {
      message.error("Could not remove");
    }
  };

  const stat = (label: string, value: number, tone?: string) => (
    <div className="card batch-stat">
      <div className="batch-stat-value" style={tone ? { color: `var(${tone})` } : undefined}>{value}</div>
      <div className="faint" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );

  return (
    <AppShell>
      <input ref={resumeRef} type="file" multiple hidden onChange={onResumePicked} />
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => nav("/batches")} style={{ marginBottom: 6 }}>
            ← Batches
          </button>
          <h1 style={{ margin: 0, overflowWrap: "anywhere" }}>{batch.name}</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            Started {dayjs(batch.createdAt).format("MMM D, YYYY h:mm A")}
            {batch.completedAt && ` · completed ${dayjs(batch.completedAt).format("h:mm A")}`}
            {batch.folderId && (
              <>
                {" · "}
                <a href={`/folders/${batch.folderId}`} onClick={(e) => { e.preventDefault(); nav(`/folders/${batch.folderId}`); }}>
                  open set
                </a>
              </>
            )}
          </span>
        </div>
        <span className={`badge ${batch.status === "completed" ? "ready" : "processing"}`} style={{ marginTop: 32 }}>
          <span className="dot" /> {STATUS_LABEL[batch.status]}
        </span>
      </div>

      <div className="batch-stats">
        {stat("Files", c.total)}
        {stat("Ready", c.ready, "--success")}
        {stat("Processing", c.processing + c.uploading, "--attention")}
        {stat("Needs review", c.needsReview, "--attention")}
        {stat("Failed", c.failed + c.uploadFailed, "--danger")}
        {stat("Not uploaded", c.notUploaded)}
      </div>

      {unfinished.length > 0 && !uploads.busy && (
        <div className="card" style={{ padding: 14, margin: "12px 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 220 }}>
            <strong>{unfinished.length} file{unfinished.length > 1 ? "s" : ""}</strong> did not finish uploading (for example
            the page was closed). Select the same files again to resume, or cancel them.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => resumeRef.current?.click()}>
            Select files to resume
          </button>
          <button
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() =>
              window.confirm(`Cancel ${unfinished.length} unfinished file(s)?`) &&
              run("cancel", async () => {
                const r = await cancelUnfinished(batch._id, user._id);
                return `Cancelled ${r.cancelled} file${r.cancelled === 1 ? "" : "s"}`;
              })
            }
          >
            Cancel them
          </button>
        </div>
      )}

      <div className="card" style={{ display: "flex", gap: 8, padding: 10, margin: "12px 0", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {(["all", "problems"] as const).map((f) => (
            <button
              key={f}
              className="btn btn-sm"
              style={{ border: "none", borderRadius: 0, background: filter === f ? "var(--overlay)" : "transparent" }}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
            >
              {f === "all" ? `All (${data.items.length})` : "Needs attention"}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn btn-sm"
            disabled={failedDocs === 0 || !!busy}
            onClick={() =>
              run("retry", async () => {
                const r = await retryFailedInBatch(batch._id, user._id);
                return `Retrying ${r.retried} document${r.retried === 1 ? "" : "s"}`;
              })
            }
          >
            {busy === "retry" ? "Retrying…" : `Retry failed${failedDocs ? ` (${failedDocs})` : ""}`}
          </button>
          <button
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() => run("report", async () => {
              await downloadBatchReport(batch._id, user._id);
              return "Report downloaded";
            })}
          >
            Download report (CSV)
          </button>
        </span>
      </div>

      <div className="list" role="table" aria-label="Files in this batch">
        {rows.length === 0 && (
          <div className="row" style={{ color: "var(--muted)" }}>Nothing needs attention.</div>
        )}
        {rows.map((r) => (
          <div key={`${r.index}-${r.documentId}`} className="row" role="row">
            <span className="faint" style={{ width: 34, fontSize: 12, flexShrink: 0 }}>{r.index === null ? "" : r.index + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: r.documentId && r.state !== "failed" ? "pointer" : "default" }}
                onClick={() => r.documentId && r.state !== "failed" && nav(`/files/${r.documentId}`)}
                title={r.path || r.name}
              >
                {r.name}
              </div>
              <div className="faint" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fmtSize(r.size)}
                {r.path && r.path !== r.name ? ` · ${r.path}` : ""}
              </div>
              {r.error && <div className="upload-error">{r.error}</div>}
            </div>
            <ItemStateBadge state={r.state} stage={r.stage} />
            {r.documentId && (
              <button className="btn btn-sm btn-danger" onClick={() => remove(r)} title="Remove document" aria-label={`Remove ${r.name}`}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      <UploadTray
        items={uploads.items}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onDismiss={uploads.dismiss}
        onClear={uploads.clearFinished}
      />
    </AppShell>
  );
}
