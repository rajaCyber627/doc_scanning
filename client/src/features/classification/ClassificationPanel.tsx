import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import axios from "axios";
import { FileItem } from "../../api";
import { errorMessage } from "../upload/uploadApi";
import { getTaxonomy, Taxonomy } from "../metadata/metadataApi";
import PersonPicker from "../metadata/PersonPicker";

const pct = (n?: number) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "—");
const tone = (n?: number) => (typeof n !== "number" ? "" : n >= 0.85 ? "ready" : n >= 0.6 ? "review" : "failed");

/** AI suggestion review: confidence per value, the quote it came from (click to find it
 *  on the page), accept all / edit, move between queues, next in queue. */
export default function ClassificationPanel({
  file,
  userId,
  canSeeRestricted,
  onChanged,
  onShowQuote,
}: {
  file: FileItem;
  userId: string;
  canSeeRestricted: boolean;
  onChanged: () => void;
  onShowQuote: (q: string) => void;
}) {
  const nav = useNavigate();
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const c0: any = (file as any).classification;
  // the AI could not tell the type: start in edit mode so the person can choose it right away
  const [editing, setEditing] = useState(() => !!c0 && c0.status === "suggested" && !c0.suggestion?.documentType);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState("");
  const c: any = (file as any).classification;
  useEffect(() => {
    getTaxonomy().then(setTax).catch(() => {});
  }, []);

  if (!c || !["suggested", "failed"].includes(c.status) || file.status !== "needs_review") return null;
  const s = c.suggestion || { fields: [] };
  const chosenType = edits.documentType || s.documentType || "";
  const queue = c.queue || "general";

  const goNext = async () => {
    const q = (await axios.get("/api/review-queue", { params: { userId, queue } })).data as { fileId: string }[];
    const next = q.find((x) => x.fileId !== file._id);
    if (next) nav(`/files/${next.fileId}`);
    else {
      message.info("The review queue is empty");
      nav("/review");
    }
  };
  const accept = async (andNext: boolean) => {
    setBusy("accept");
    try {
      const r = await axios.post(`/api/files/${file._id}/classification/accept`, { userId, metadata: edits });
      if (r.data.errors?.length) message.warning(`Accepted — ${r.data.errors.length} detail(s) still needed`);
      else message.success("Accepted");
      setEditing(false);
      setEdits({});
      onChanged();
      if (andNext) await goNext();
    } catch (e) {
      message.error(errorMessage(e, "Could not accept"));
    } finally {
      setBusy("");
    }
  };
  const move = async (to: "general" | "restricted") => {
    setBusy("move");
    try {
      await axios.post(`/api/files/${file._id}/classification/reassign`, { userId, queue: to });
      message.success(to === "restricted" ? "Moved to the restricted queue" : "Released to the general queue");
      onChanged();
    } catch (e) {
      message.error(errorMessage(e, "Could not move it"));
    } finally {
      setBusy("");
    }
  };

  const quote = (q?: string | null, page?: number | null) =>
    q ? (
      <button className="quote-chip" onClick={() => onShowQuote(q)} title="Show on the page">
        “{q}”{page ? ` · p.${page}` : ""}
      </button>
    ) : null;
  const typeName = (k?: string) => tax?.documentTypes.find((t) => t.key === k)?.name || k;

  return (
    <div className="card" id="classification-panel" style={{ marginBottom: 16, scrollMarginTop: 70 }}>
      <div className="card-header" style={{ display: "flex", gap: 8 }}>
        <span style={{ flex: 1 }}>{c.status === "failed" ? "Enter details" : "Suggested details"}</span>
        {queue === "restricted" && (
          <span className="badge failed">
            <span className="dot" /> Restricted
          </span>
        )}
      </div>
      <div style={{ padding: 14, display: "grid", gap: 10, fontSize: 13 }}>
        {c.status === "failed" ? (
          <div className="faint">{c.error}. Fill in the details in the panel below.</div>
        ) : (
          <>
            <div className="sugg-row">
              <span className="faint">Document type</span>
              {editing ? (
                <select value={edits.documentType ?? s.documentType ?? ""} onChange={(e) => setEdits({ ...edits, documentType: e.target.value })} aria-label="Document type">
                  <option value="">Choose…</option>
                  {tax?.categories.map((cat) => (
                    <optgroup key={cat.key} label={cat.name}>
                      {tax.documentTypes.filter((t) => t.categoryKey === cat.key).map((t) => (
                        <option key={t.key} value={t.key}>{t.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <strong>{typeName(s.documentType) || "Not sure"}</strong>
              )}
              <span className={`badge ${tone(c.confidence?.documentType)}`}>{pct(c.confidence?.documentType)}</span>
            </div>
            <div className="sugg-row">
              <span className="faint">Person</span>
              {editing ? (
                <PersonPicker
                  value={{ employeeName: edits.employeeName ?? s.person?.match?.name ?? s.person?.name }}
                  onPick={(p) => setEdits({ ...edits, personId: p.personId, employeeName: p.name })}
                />
              ) : (
                <strong>
                  {s.person?.match?.name || s.person?.name || "Not found"}
                  {s.person?.match?.nameMismatch ? (
                    <span style={{ color: "var(--danger)" }}> ⚠ this ID belongs to {s.person.match.name}, but the document says “{s.person.match.nameOnDocument}”</span>
                  ) : null}
                  {s.person?.match?.nameMismatch ? "" : s.person?.match?.kind === "id" ? " ✓ ID matched" : s.person?.match?.kind === "name" ? " (name match only)" : s.person?.match?.kind === "ambiguous" ? " (several people match)" : s.person?.name ? " (not in directory)" : ""}
                </strong>
              )}
              <span className={`badge ${tone(c.confidence?.person)}`}>{pct(c.confidence?.person)}</span>
            </div>
            {quote(s.person?.quote, s.person?.page)}
            <div className="sugg-row">
              <span className="faint">Confidentiality</span>
              <strong>{s.confidentialityLevel}</strong>
              <span className={`badge ${tone(c.confidence?.confidentiality)}`}>{pct(c.confidence?.confidentiality)}</span>
            </div>
            {editing && !s.documentType && (
              <div className="faint" style={{ fontSize: 12 }}>
                Not about one employee (an RFP, policy, letter, reference material)? Choose a type under “General &amp; reference documents” — no employee is needed.
              </div>
            )}
            {(s.fields || []).map((f: any) => (
              <div key={f.key}>
                <div className="sugg-row">
                  <span className="faint">{f.key}</span>
                  {editing ? (
                    <input aria-label={f.key} value={edits[f.key] ?? f.value} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })} />
                  ) : (
                    <strong>{f.value}</strong>
                  )}
                  <span className={`badge ${tone(f.confidence)}`}>{pct(f.confidence)}</span>
                </div>
                {quote(f.quote, f.page)}
              </div>
            ))}
            {c.textTruncated && <div className="faint">Only the first part of a long document was read.</div>}
          </>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {c.status === "suggested" && (
            <>
              <button className="btn btn-sm btn-primary" disabled={!!busy || !chosenType} title={chosenType ? undefined : "Choose the document type first"} onClick={() => accept(false)}>
                {editing ? "Save & accept" : "Accept all"}
              </button>
              <button className="btn btn-sm" disabled={!!busy || !chosenType} onClick={() => accept(true)}>
                {editing ? "Save, accept & next" : "Accept & next"}
              </button>
              {!editing && (
                <button className="btn btn-sm" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </>
          )}
          {queue === "general" ? (
            <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => move("restricted")} title="Medical, FMLA, ADA, workers' comp, investigations, grievances">
              Move to restricted
            </button>
          ) : (
            canSeeRestricted && (
              <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => move("general")}>
                Release to general
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
