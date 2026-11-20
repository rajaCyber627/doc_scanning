import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { message } from "antd";
import dayjs from "dayjs";
import AppShell from "../../components/AppShell";
import { useUploads } from "../upload/useUploads";
import UploadTray from "../upload/UploadTray";
import { errorMessage } from "../upload/uploadApi";
import BulkEditModal from "../metadata/BulkEditModal";
import { closeBatch, retryFailedInBatch } from "./batchApi";
import { DocTag, downloadReconciliation, getQcSettings, getScanSummary, recordQc, sampleQc, ScanSummary } from "./scanBatchApi";

const TILES: { key: "documents" | DocTag; label: string; tone?: string }[] = [
  { key: "documents", label: "Documents" },
  { key: "ready", label: "Ready", tone: "--success" },
  { key: "needs_review", label: "Needs review", tone: "--attention" },
  { key: "restricted", label: "Restricted", tone: "--danger" },
  { key: "duplicate", label: "Possible duplicates", tone: "--attention" },
  { key: "split_suggested", label: "Split to check", tone: "--attention" },
  { key: "rescan", label: "Rescan", tone: "--danger" },
  { key: "failed", label: "Failed", tone: "--danger" },
  { key: "processing", label: "Processing" },
];
const TAG_LABEL: Partial<Record<DocTag, string>> = { restricted: "Restricted", duplicate: "Duplicate?", split_suggested: "Split?", rescan: "Rescan", failed: "Failed" };
const SPLIT_LABEL = { separators: "separator sheets only", suggest: "separator sheets, else AI suggests cuts", auto: "separator sheets, else AI cuts automatically" };

/** Scan batch dashboard (P14): pages in vs pages in documents, documents by state with
 *  drill-down and bulk actions, quality-control sample, reconciliation report. */
export default function ScanBatchView({ batchId, userId }: { batchId: string; userId: string }) {
  const nav = useNavigate();
  const [s, setS] = useState<ScanSummary | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"documents" | DocTag>("documents");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const [qcPct, setQcPct] = useState(10);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const pickRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getScanSummary(batchId, userId)
      .then((d) => {
        setS(d);
        setError("");
      })
      .catch((e) => setError(errorMessage(e, "Could not load this batch")));
  }, [batchId, userId]);
  useEffect(load, [load]);
  useEffect(() => {
    getQcSettings()
      .then((q) => setQcPct(q.percent))
      .catch(() => {});
  }, []);
  const uploads = useUploads(userId, load);
  const live = !!s && (s.batch.status !== "completed" || s.pending || uploads.busy);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [live, load]);

  const rows = useMemo(() => (!s ? [] : filter === "documents" ? s.documents : s.documents.filter((d) => d.tags.includes(filter as DocTag))), [s, filter]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const msg = await fn();
      if (msg) message.success(msg);
      load();
    } catch (e) {
      message.error(errorMessage(e, "That did not work"));
    } finally {
      setBusy("");
    }
  };

  if (error && !s)
    return (
      <AppShell>
        <div className="card" style={{ padding: 24, color: "var(--danger)" }}>{error}</div>
      </AppShell>
    );
  if (!s)
    return (
      <AppShell>
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      </AppShell>
    );

  const { batch, pages, counts, qc } = s;
  const pct = pages.expected ? Math.min(100, Math.round((pages.received / pages.expected) * 100)) : null;
  const toggle = (id: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <AppShell>
      <input
        ref={pickRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.tif,.tiff,.jpg,.jpeg,.png,.heic"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          if (files.length) uploads.enqueue(files, { batchId: batch._id });
        }}
      />
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => nav("/batches")} style={{ marginBottom: 6 }}>
            ← Batches
          </button>
          <h1 style={{ margin: 0, overflowWrap: "anywhere" }}>{batch.name}</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            Scan batch{batch.boxId && ` · box ${batch.boxId}`} · started {dayjs(batch.createdAt).format("MMM D, YYYY h:mm A")} · split: {SPLIT_LABEL[batch.splitMode]}
            {batch.completedAt && ` · completed ${dayjs(batch.completedAt).format("MMM D h:mm A")}`}
          </span>
        </div>
        <span className={`badge ${batch.status === "completed" ? "ready" : "processing"}`} style={{ marginTop: 32 }}>
          <span className="dot" /> {batch.status === "completed" ? "Completed" : batch.closedAt ? "Finishing" : "Receiving pages"}
        </span>
      </div>

      {!batch.closedAt && (
        <div className="card" style={{ padding: 12, marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
          <strong style={{ marginRight: 4 }}>Add pages:</strong>
          <button className="btn btn-sm" onClick={() => pickRef.current?.click()}>
            ⬆ Upload scans
          </button>
          <Link className="btn btn-sm" to={`/scan?batch=${batch._id}`}>
            📷 Scan with camera
          </Link>
          {batch.boxId && (
            <span className="faint">
              or save from the copier into the scanner folder <code>{batch.boxId}</code>
            </span>
          )}
          <button className="btn btn-sm btn-primary" style={{ marginLeft: "auto" }} disabled={!!busy || uploads.busy} onClick={() =>
              run("close", async () => {
                await closeBatch(batch._id, userId);
                return "Batch finished — it completes once every page is processed";
              })
            }
          >
            Finish batch
          </button>
        </div>
      )}

      <div className="card scan-recon" role="group" aria-label="Page reconciliation">
        <div>
          <div className="batch-stat-value">{pages.received}</div>
          <div className="faint">pages received{pages.expected ? ` of ${pages.expected} expected` : ""}</div>
          {pct !== null && (
            <div className="progress" aria-label={`${pct}% of the expected pages received`}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div>
          <div className="batch-stat-value">{pages.inDocuments}</div>
          <div className="faint">in documents</div>
        </div>
        <div>
          <div className="batch-stat-value">{pages.removed}</div>
          <div className="faint">removed (separators, blanks)</div>
        </div>
        <div>
          <div className="batch-stat-value" style={{ color: pages.missing ? "var(--danger)" : pages.missing === 0 ? "var(--success)" : undefined }}>{pages.missing ?? "…"}</div>
          <div className="faint">missing{pages.missing === null ? " (still processing)" : ""}</div>
        </div>
      </div>

      <div className="batch-stats" role="tablist" aria-label="Filter documents">
        {TILES.filter((t) => t.key === "documents" || counts[t.key] > 0).map((t) => (
          <button key={t.key} role="tab" aria-selected={filter === t.key} className={`card batch-stat clickable${filter === t.key ? " selected" : ""}`} onClick={() => setFilter(t.key)}>
            <div className="batch-stat-value" style={t.tone ? { color: `var(${t.tone})` } : undefined}>{counts[t.key]}</div>
            <div className="faint" style={{ fontSize: 12 }}>{t.label}</div>
          </button>
        ))}
      </div>

      <div className="card" style={{ margin: "12px 0" }}>
        <div className="card-header" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}>
            {rows.length} document{rows.length === 1 ? "" : "s"}
            {filter !== "documents" && ` · ${TILES.find((t) => t.key === filter)?.label.toLowerCase()}`}
          </span>
          <button className="btn btn-sm" disabled={!selected.size} onClick={() => setBulkEdit(true)}>
            ✎ Edit details{selected.size ? ` (${selected.size})` : ""}
          </button>
          {counts.failed > 0 && (
            <button className="btn btn-sm" disabled={!!busy} onClick={() => run("retry", async () => `Retrying ${(await retryFailedInBatch(batch._id, userId)).retried} document(s)`)}>
              ↻ Retry failed
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="faint" style={{ padding: 20 }}>{s.documents.length ? "Nothing in this group." : "No pages received yet."}</div>
        ) : (
          <div className="list" style={{ border: "none" }}>
            {rows.map((d) => (
              <div key={d.fileId} className="row">
                <input type="checkbox" style={{ width: "auto" }} aria-label={`Select ${d.fileName}`} checked={selected.has(d.fileId)} onChange={() => toggle(d.fileId)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link to={`/files/${d.fileId}`} style={{ fontWeight: 600 }}>
                    {d.fileName}
                  </Link>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {d.pages ?? "?"} page{d.pages === 1 ? "" : "s"}
                    {d.fromPages && ` (stack pages ${d.fromPages[0]}–${d.fromPages[d.fromPages.length - 1]})`} · {d.documentTypeName || "type not set"} · {d.person || "person not set"}
                    {d.confirmed ? " · details confirmed" : ""}
                  </div>
                  {(d.reasons.length > 0 || d.error) && <div className="faint" style={{ fontSize: 12, color: "var(--attention)" }}>{d.error || d.reasons[0]}</div>}
                </div>
                {d.tags
                  .filter((t) => TAG_LABEL[t])
                  .map((t) => (
                    <span key={t} className={`badge ${t === "restricted" || t === "rescan" || t === "failed" ? "failed" : "review"}`}>
                      <span className="dot" /> {TAG_LABEL[t]}
                    </span>
                  ))}
                <span className={`badge ${d.status === "ready" ? "ready" : d.status === "failed" ? "failed" : d.status === "processing" ? "processing" : "review"}`}>
                  <span className="dot" /> {d.status.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="scan-batch-grid">
        <div className="card">
          <div className="card-header">Quality check</div>
          <div style={{ padding: 12, display: "grid", gap: 8, fontSize: 13 }}>
            <span className="faint">A random sample of the finished documents is checked against the paper. A failed document is marked for rescanning.</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <label>
                Sample{" "}
                <input type="number" min={1} max={100} value={qcPct} onChange={(e) => setQcPct(Number(e.target.value) || 10)} style={{ width: 64 }} aria-label="Sample percent" />%
              </label>
              <button
                className="btn btn-sm"
                disabled={!!busy || !counts.documents}
                onClick={() =>
                  run("qc", async () => {
                    const replace = !!qc && qc.items.some((i) => i.result) && window.confirm("Replace the current sample and its results?");
                    if (qc && qc.items.some((i) => i.result) && !replace) return;
                    const r = await sampleQc(batch._id, userId, qcPct, replace);
                    return `${r.items.length} of ${r.eligible} documents picked for checking`;
                  })
                }
              >
                {qc ? "New sample" : "Pick sample"}
              </button>
            </div>
            {qc && (
              <>
                <span>
                  {qc.items.length} of {qc.eligible} documents ({qc.percent}%) · <b>{qc.passed}</b> passed · <b style={{ color: qc.failed ? "var(--danger)" : undefined }}>{qc.failed}</b> failed · {qc.pending} to check
                </span>
                {qc.items.map((it) => (
                  <div key={it.fileId} className="inset" style={{ padding: 8, display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <Link to={`/files/${it.fileId}`} style={{ flex: 1, overflowWrap: "anywhere" }}>
                        {it.fileName}
                      </Link>
                      {it.result && <span className={`badge ${it.result === "pass" ? "ready" : "failed"}`}>{it.result === "pass" ? "Passed" : "Failed"}</span>}
                    </div>
                    {it.result === "fail" && it.note && <span className="faint">{it.note}</span>}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => run("qcr", async () => void (await recordQc(batch._id, it.fileId, userId, "pass")))}>
                        ✓ Pass
                      </button>
                      <input aria-label={`What is wrong with ${it.fileName}`} placeholder="What is wrong? (for a fail)" value={notes[it.fileId] ?? ""} onChange={(e) => setNotes({ ...notes, [it.fileId]: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
                      <button className="btn btn-sm" disabled={!!busy || !(notes[it.fileId] || "").trim()} onClick={() => run("qcr", async () => void (await recordQc(batch._id, it.fileId, userId, "fail", notes[it.fileId])))}>
                        ✕ Fail
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-header">Reconciliation report</div>
          <div style={{ padding: 12, display: "grid", gap: 8, fontSize: 13 }}>
            <span className="faint">Pages in versus pages in documents, documents per type and person, exceptions and the quality-check result — the record that this box was converted completely.</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => run("csv", () => downloadReconciliation(batch._id, userId, "csv"))}>
                ⬇ CSV
              </button>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => run("pdf", () => downloadReconciliation(batch._id, userId, "pdf"))}>
                ⬇ PDF
              </button>
            </div>
            {s.byType.length > 0 && (
              <table className="acc-table">
                <thead>
                  <tr>
                    <th>Document type</th>
                    <th>Documents</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byType.map((g) => (
                    <tr key={g.label}>
                      <td>{g.label}</td>
                      <td>{g.documents}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {uploads.items.length > 0 && <UploadTray items={uploads.items} onCancel={uploads.cancel} onRetry={uploads.retry} onDismiss={uploads.dismiss} onClear={uploads.clearFinished} />}
      {bulkEdit && (
        <BulkEditModal
          userId={userId}
          fileIds={Array.from(selected)}
          onClose={() => setBulkEdit(false)}
          onDone={() => {
            setSelected(new Set());
            load();
          }}
        />
      )}
    </AppShell>
  );
}
