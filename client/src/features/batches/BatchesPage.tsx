import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { listBatches, BatchSummary } from "./batchApi";

const STATUS_LABEL = { open: "Uploading", processing: "Processing", completed: "Completed" } as const;

/** All intake batches for the current user, newest first. */
export default function BatchesPage() {
  const user = getUser()!;
  const nav = useNavigate();
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState("");

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

  return (
    <AppShell>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Batches</h1>
        <span className="faint" style={{ fontSize: 13 }}>
          Every multi-file upload is tracked here: progress, failures, retries and a downloadable report.
        </span>
      </div>
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
                <span aria-hidden>🗂</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                  <div className="faint" style={{ fontSize: 12 }}>
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
