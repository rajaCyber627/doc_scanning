import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Page, pdfjs } from "react-pdf";
import { message } from "antd";
import { errorMessage } from "../upload/uploadApi";
import { getPagesPdf } from "../splitting/splitApi";
import { MergeItem, MergePreview, mergeFiles, move, previewMerge } from "./mergeApi";

pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ""}/pdf.worker.min.js`;

type Item = MergeItem & { key: string };
const FIELD_LABEL: Record<string, string> = { person: "Person", documentType: "Document type" };

/** Merge 2+ documents (or some of their pages) into one: drag to reorder, rotate, leave
 *  pages out, resolve disagreeing details; the result is never less confidential. */
export default function MergeModal({ userId, fileIds, onClose }: { userId: string; fileIds: string[]; onClose: () => void }) {
  const nav = useNavigate();
  const [pv, setPv] = useState<MergePreview | null>(null);
  const [error, setError] = useState("");
  const [pdfs, setPdfs] = useState<Record<string, any>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [left, setLeft] = useState<Item[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [supersede, setSupersede] = useState(false);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    (async () => {
      try {
        const p = await previewMerge(userId, fileIds);
        if (!alive) return;
        setPv(p);
        const loaded: Record<string, any> = {};
        const all: Item[] = [];
        for (const s of p.sources) {
          const url = URL.createObjectURL(await getPagesPdf(s.fileId, userId));
          urls.push(url);
          const doc = await pdfjs.getDocument(url).promise;
          loaded[s.fileId] = doc;
          for (let n = 1; n <= doc.numPages; n++) all.push({ fileId: s.fileId, page: n, rotate: 0, key: `${s.fileId}:${n}` });
        }
        if (!alive) return;
        setPdfs(loaded);
        setItems(all);
      } catch (e) {
        if (alive) setError(errorMessage(e, "Could not load these documents"));
      }
    })();
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [userId, fileIds]);

  const nameOf = useMemo(() => Object.fromEntries((pv?.sources || []).map((s) => [s.fileId, s.fileName])), [pv]);
  const docsUsed = new Set(items.map((i) => i.fileId)).size;
  const unresolved = (pv?.conflicts || []).filter((c) => resolution[c.field] === undefined);
  const canMerge = items.length >= 2 && docsUsed >= 2 && !unresolved.length && (!pv?.mixedRestricted || ack) && !busy;

  const removeAt = (i: number) => {
    setLeft((l) => [...l, items[i]]);
    setItems((it) => it.filter((_, j) => j !== i));
  };
  const restore = (k: string) => {
    const it = left.find((x) => x.key === k);
    if (!it) return;
    setLeft((l) => l.filter((x) => x.key !== k));
    setItems((xs) => [...xs, it]);
  };
  const rotate = (i: number) => setItems((it) => it.map((x, j) => (j === i ? { ...x, rotate: (x.rotate + 90) % 360 } : x)));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await mergeFiles(userId, {
        pages: items.map(({ fileId, page, rotate: rot }) => ({ fileId, page, rotate: rot })),
        name: name.trim() || undefined,
        supersede,
        resolution,
        acknowledgeRestricted: ack,
      });
      message.success(`Merged into "${r.fileName}" (${r.pageCount} pages)`);
      onClose();
      nav(`/files/${r.fileId}`);
    } catch (e) {
      message.error(errorMessage(e, "Could not merge"));
    } finally {
      setBusy(false);
    }
  };

  const thumb = (it: Item, width: number) =>
    pdfs[it.fileId] ? (
      <Page pdf={pdfs[it.fileId]} pageNumber={it.page} width={width} rotate={it.rotate} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="split-thumb-ph" style={{ width, height: width * 1.29 }} />} />
    ) : (
      <div className="split-thumb-ph" style={{ width, height: width * 1.29 }} />
    );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Merge documents" onClick={onClose}>
      <div className="card compare-modal" style={{ maxWidth: 1000 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-header" style={{ display: "flex" }}>
          <span style={{ flex: 1 }}>Merge {fileIds.length} documents</span>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? (
          <div style={{ padding: 16, color: "var(--danger)" }}>{error}</div>
        ) : !pv ? (
          <div style={{ padding: 16 }}>Loading…</div>
        ) : (
          <div style={{ padding: 14, display: "grid", gap: 12, maxHeight: "75vh", overflow: "auto", fontSize: 13 }}>
            <span className="faint">Drag pages into the order you want (or use ← →). The originals are kept and linked to the new document.</span>
            <div className="merge-grid" role="list" aria-label="Pages of the merged document">
              {items.map((it, i) => (
                <figure
                  key={it.key}
                  role="listitem"
                  className={`split-thumb merge-item${drag === i ? " dragging" : ""}`}
                  draggable
                  onDragStart={() => setDrag(i)}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag !== null) setItems((xs) => move(xs, drag, i));
                    setDrag(null);
                  }}
                  aria-label={`Page ${i + 1}: ${nameOf[it.fileId]} page ${it.page}`}
                >
                  {thumb(it, 120)}
                  <figcaption>
                    <span title={nameOf[it.fileId]} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 70 }}>
                      {i + 1}. p.{it.page}
                    </span>
                    <span style={{ marginLeft: "auto", display: "inline-flex" }}>
                      <button className="btn btn-sm btn-ghost" aria-label={`Move page ${i + 1} earlier`} disabled={i === 0} onClick={() => setItems((xs) => move(xs, i, i - 1))}>
                        ←
                      </button>
                      <button className="btn btn-sm btn-ghost" aria-label={`Move page ${i + 1} later`} disabled={i === items.length - 1} onClick={() => setItems((xs) => move(xs, i, i + 1))}>
                        →
                      </button>
                      <button className="btn btn-sm btn-ghost" aria-label={`Rotate page ${i + 1}`} onClick={() => rotate(i)}>
                        ↻
                      </button>
                      <button className="btn btn-sm btn-ghost" aria-label={`Leave out page ${i + 1}`} onClick={() => removeAt(i)}>
                        ✕
                      </button>
                    </span>
                  </figcaption>
                  <div className="merge-src faint">{nameOf[it.fileId]}</div>
                </figure>
              ))}
            </div>
            {left.length > 0 && (
              <div>
                <strong>Left out:</strong>{" "}
                {left.map((it) => (
                  <button key={it.key} className="btn btn-sm btn-ghost" onClick={() => restore(it.key)} aria-label={`Put back ${nameOf[it.fileId]} page ${it.page}`}>
                    ↺ {nameOf[it.fileId]} p.{it.page}
                  </button>
                ))}
              </div>
            )}

            {pv.conflicts.map((c) => (
              <fieldset key={c.field} className="inset" style={{ padding: 10, border: "1px solid var(--warning, #c90)" }}>
                <legend>
                  <strong>{FIELD_LABEL[c.field]}:</strong> the documents disagree — choose one
                </legend>
                {c.values.map((v) => (
                  <label key={v.value} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="radio" style={{ width: "auto" }} name={c.field} checked={resolution[c.field] === v.value} onChange={() => setResolution((r) => ({ ...r, [c.field]: v.value }))} />
                    {v.label} <span className="faint">({v.fileIds.map((id) => nameOf[id]).join(", ")})</span>
                  </label>
                ))}
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" style={{ width: "auto" }} name={c.field} checked={resolution[c.field] === ""} onChange={() => setResolution((r) => ({ ...r, [c.field]: "" }))} />
                  Decide when reviewing the merged document
                </label>
              </fieldset>
            ))}
            {pv.mixedRestricted && (
              <label className="inset" style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", color: "var(--danger)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                Some pages are restricted (medical, leave, ADA, investigations…). The merged document will be Restricted — only permitted staff will see it.
              </label>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input aria-label="Name of the merged document" placeholder={`Name (default: ${(nameOf[items[0]?.fileId] || "document").replace(/\.[^.]+$/, "")} (merged))`} value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={supersede} onChange={(e) => setSupersede(e.target.checked)} />
                Mark the originals as replaced (kept, hidden from lists)
              </label>
            </div>
          </div>
        )}
        <div style={{ padding: 14, display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {pv && <span className="faint" style={{ marginRight: "auto" }}>{items.length} pages from {docsUsed} documents · will be {pv.confidentiality || "confidential"}</span>}
          <button className="btn btn-primary" disabled={!canMerge} onClick={submit}>
            {busy ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
