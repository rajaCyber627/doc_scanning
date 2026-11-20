import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { listBatches, BatchSummary } from "./batchApi";
import { startScanBatch } from "./scanBatchApi";
import { errorMessage } from "../upload/uploadApi";

const STATUS_LABEL = { open: "Uploading", processing: "Processing", completed: "Completed" } as const;

/** All intake batches for the current user, newest first. */
export default function BatchesPage() {
  const user = getUser()!;
  const nav = useNavigate();
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState("");
  const [showStart, setShowStart] = useState(false);
  const [startError, setStartError] = useState("");
  const [form, setForm] = useState({ name: "", boxId: "", expectedPages: "", splitMode: "suggest" });

  const load = useCallback(() => {
    listBatches(user._id)
      .then((b) => {
        setBatches(b);
        setError("");
      })
      .catch(() => setError("Could not load batches"));
  }, [user._id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!batches?.some((b) => b.status !== "completed")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [batches, load]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setStartError("");
    try {
      const b = await startScanBatch({ userId: user._id, name: form.name || undefined, boxId: form.boxId || undefined, expectedPages: form.expectedPages ? Number(form.expectedPages) : undefined, splitMode: form.splitMode });
      nav(`/batches/${b._id}`);
    } catch (err) {
      setStartError(errorMessage(err, "Could not start the batch"));
    }
  };

  return (
    <AppShell>
      <div style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: 0 }}>Batches</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            Every multi-file upload and scan run is tracked here: progress, failures, retries and reports.
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => setShowStart((v) => !v)} aria-expanded={showStart}>
          ＋ Start scan batch
        </button>
      </div>
      {showStart && (
        <form className="card" style={{ padding: 14, marginBottom: 16, display: "grid", gap: 8, fontSize: 13 }} onSubmit={start} aria-label="Start a scan batch">
          <span className="faint">A scan batch follows a stack of paper from the scanner to filed documents, with a quality check and a reconciliation report.</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input aria-label="Batch name" placeholder="Name (e.g. HR records box 12)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ flex: 2, minWidth: 200 }} />
            <input aria-label="Box or folder ID" placeholder="Box / folder ID" value={form.boxId} onChange={(e) => setForm({ ...form, boxId: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
            <input aria-label="Expected pages" placeholder="Expected pages" inputMode="numeric" value={form.expectedPages} onChange={(e) => setForm({ ...form, expectedPages: e.target.value.replace(/\D/g, "") })} style={{ width: 130 }} />
          </div>
          <label>
            Separating documents{" "}
            <select aria-label="Split mode" value={form.splitMode} onChange={(e) => setForm({ ...form, splitMode: e.target.value })}>
              <option value="suggest">Separator sheets; otherwise the AI suggests cuts to check</option>
              <option value="auto">Separator sheets; otherwise the AI cuts automatically</option>
              <option value="separators">Separator sheets only</option>
            </select>
          </label>
          {startError && <span style={{ color: "var(--danger)" }} role="alert">{startError}</span>}
          <div>
            <button className="btn btn-primary btn-sm" type="submit">
              Start
            </button>
          </div>
        </form>
      )}
      {error && <div className="card" style={{ padding: 16, color: "var(--danger)" }}>{error}</div>}
      {!batches ? (
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : batches.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
          No batches yet. Upload several files (or a whole folder) on the Documents page.
        </div>
      ) : (
        <div className="list">
          {batches.map((b) => {
            const c = b.counts;
            const failed = c.failed + c.uploadFailed;
            return (
              <div key={b._id} className="row clickable" onClick={() => nav(`/batches/${b._id}`)}>
                <span aria-hidden>{b.kind === "scan" ? "🖨" : "🗂"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {b.kind === "scan" ? `Scan batch${b.boxId ? ` · box ${b.boxId}` : ""} · ` : ""}
                    {dayjs(b.createdAt).format("MMM D, YYYY h:mm A")} · {c.total} file{c.total === 1 ? "" : "s"}
                  </div>
                </div>
                <span className="label">{c.ready} ready</span>
                {c.needsReview > 0 && <span className="label">{c.needsReview} to review</span>}
                {failed > 0 && <span className="badge failed"><span className="dot" /> {failed} failed</span>}
                <span className={`badge ${b.status === "completed" ? "ready" : "processing"}`}>
                  <span className="dot" /> {STATUS_LABEL[b.status]}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
