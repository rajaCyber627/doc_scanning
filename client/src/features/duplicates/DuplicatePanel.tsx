import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import axios from "axios";
import dayjs from "dayjs";
import { errorMessage } from "../upload/uploadApi";

interface Match {
  kind: "exact" | "content";
  where: "hub" | "partner";
  similarity: number;
  sameBatch: boolean;
  restricted: boolean;
  removed?: boolean;
  fileId?: string;
  fileName?: string;
  uploadedAt?: string;
  uploadedBy?: string;
  status?: string;
  superseded?: boolean;
  summary?: string;
}
interface Info {
  document: { fileId: string; fileName: string; uploadedAt: string; summary?: string; status: string };
  open: boolean;
  matches: Match[];
}

const ACTIONS: { key: "keep_both" | "replace" | "discard"; label: string; help: string }[] = [
  { key: "keep_both", label: "Keep both", help: "They are different documents (or both copies are needed)." },
  { key: "replace", label: "Replace existing", help: "This is the newer version. The earlier one is kept, marked as replaced." },
  { key: "discard", label: "Discard this copy", help: "This upload was a mistake. It will be removed." },
];

function describe(m: Match) {
  if (m.restricted && !m.fileName) return m.where === "partner" ? "A restricted record in the HR records system" : "A restricted record (details hidden)";
  if (m.where === "partner") return "Already in the HR records system";
  return m.kind === "exact" ? "Same file" : `Same content (${Math.round(m.similarity * 100)}% similar)`;
}

/** "Possible duplicate" card: what matched, side-by-side compare, and the decision. */
export default function DuplicatePanel({ fileId, userId, onChanged }: { fileId: string; userId: string; onChanged: () => void }) {
  const nav = useNavigate();
  const [info, setInfo] = useState<Info | null>(null);
  const [compare, setCompare] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [previews, setPreviews] = useState<Record<string, string | null>>({});

  // Load previews through the API (object URLs work behind any dev proxy).
  useEffect(() => {
    if (!compare || !info) return;
    const ids = [info.document.fileId, ...info.matches.filter((m) => m.fileId).map((m) => m.fileId!)].slice(0, 2);
    const urls: string[] = [];
    let alive = true;
    Promise.all(
      ids.map((id) =>
        axios
          .get(`/api/files/${id}/preview`, { responseType: "blob" })
          .then((r) => {
            const u = URL.createObjectURL(r.data as Blob);
            urls.push(u);
            return [id, u] as const;
          })
          .catch(() => [id, null] as const)
      )
    ).then((pairs) => alive && setPreviews(Object.fromEntries(pairs)));
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [compare, info]);

  const load = useCallback(() => {
    axios
      .get(`/api/files/${fileId}/duplicates`, { params: { userId } })
      .then((r) => setInfo(r.data))
      .catch(() => setInfo(null));
  }, [fileId, userId]);
  useEffect(load, [load]);

  if (!info || !info.matches.length) return null;

  const act = async (action: (typeof ACTIONS)[number]["key"]) => {
    if (action === "discard" && !window.confirm(`Remove "${info.document.fileName}"? The earlier copy stays.`)) return;
    setBusy(action);
    try {
      const r = await axios.post(`/api/files/${fileId}/duplicate-decision`, { userId, action, reason });
      message.success(action === "discard" ? "Copy removed" : "Decision saved");
      if (r.data.deleted) nav("/documents");
      else {
        load();
        onChanged();
      }
    } catch (e) {
      message.error(errorMessage(e, "Could not save the decision"));
    } finally {
      setBusy("");
    }
  };

  const first = info.matches.find((m) => m.fileId);
  return (
    <div className="card dup-panel" id="duplicate-panel" style={{ marginBottom: 16 }}>
      <div className="card-header">{info.open ? "Possible duplicate" : "Duplicate check"}</div>
      <div style={{ padding: 14, display: "grid", gap: 10, fontSize: 13 }}>
        {info.matches.map((m, i) => (
          <div key={i} className="inset" style={{ padding: "8px 10px" }}>
            <div style={{ fontWeight: 600 }}>{describe(m)}</div>
            {m.fileName && (
              <div className="faint" style={{ marginTop: 2 }}>
                “{m.fileName}” · {m.uploadedBy} · {m.uploadedAt ? dayjs(m.uploadedAt).format("MMM D, YYYY") : ""}
                {m.sameBatch ? " · this batch" : ""}
                {m.superseded ? " · replaced" : ""}
              </div>
            )}
            {m.removed && <div className="faint">The earlier copy has since been removed.</div>}
          </div>
        ))}
        {first && (
          <button className="btn btn-sm" onClick={() => setCompare(true)}>
            Compare side by side
          </button>
        )}
        {info.open && (
          <>
            <label className="faint" htmlFor="dup-reason" style={{ fontSize: 12 }}>
              Reason (recorded in the audit trail)
            </label>
            <input id="dup-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. signed copy replaces unsigned" style={{ height: 30 }} />
            <div style={{ display: "grid", gap: 6 }}>
              {ACTIONS.filter((a) => a.key !== "replace" || first).map((a) => (
                <button
                  key={a.key}
                  className={`btn btn-sm${a.key === "discard" ? " btn-danger" : ""}`}
                  disabled={!!busy}
                  onClick={() => act(a.key)}
                  title={a.help}
                  style={{ display: "block", textAlign: "left" }}
                >
                  <span style={{ display: "block", fontWeight: 600 }}>{busy === a.key ? "Saving…" : a.label}</span>
                  <span className="faint" style={{ display: "block", fontWeight: 400, fontSize: 12 }}>{a.help}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {compare && first && (
        <div className="modal-backdrop" onClick={() => setCompare(false)} role="dialog" aria-modal="true" aria-label="Compare documents">
          <div className="card compare-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <span>Compare documents</span>
              <button className="btn btn-sm" onClick={() => setCompare(false)}>
                Close
              </button>
            </div>
            <div className="compare-grid">
              {[
                { title: "This upload", fileId: info.document.fileId, name: info.document.fileName, date: info.document.uploadedAt, summary: info.document.summary },
                { title: describe(first), fileId: first.fileId!, name: first.fileName!, date: first.uploadedAt, summary: first.summary },
              ].map((side) => (
                <div key={side.fileId} className="compare-side">
                  <div className="faint" style={{ fontSize: 12 }}>{side.title}</div>
                  <div style={{ fontWeight: 600, margin: "2px 0 6px" }}>{side.name}</div>
                  <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>{side.date ? dayjs(side.date).format("MMM D, YYYY h:mm A") : ""}</div>
                  {previews[side.fileId] ? (
                    <iframe title={side.name} src={previews[side.fileId]!} className="compare-frame" />
                  ) : (
                    <div className="compare-frame compare-empty">{previews[side.fileId] === null ? "No preview available" : "Loading preview…"}</div>
                  )}
                  <p className="faint" style={{ fontSize: 12 }}>{side.summary}</p>
                  <button className="btn btn-sm" onClick={() => nav(`/files/${side.fileId}`)}>
                    Open
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
