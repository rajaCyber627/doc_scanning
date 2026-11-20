import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Document, Page, pdfjs } from "react-pdf";
import { message } from "antd";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { errorMessage } from "../upload/uploadApi";
import { getTaxonomy, Taxonomy } from "../metadata/metadataApi";
import { getPages, getPagesPdf, PagesInfo, splitFile, suggestSplit, Suggestion } from "./splitApi";
import { buildRequest, keptPages, partsFromCuts, PartMeta } from "./splitPlan";
import SeparatorSheetCard from "./SeparatorSheetCard";

pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ""}/pdf.worker.min.js`;

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Page view: thumbnails, zoom, rotate, remove pages; place cuts by hand, from the AI's
 *  suggestion or at separator sheets; name/type each part; preview; confirm. */
export default function SplitPage() {
  const { id = "" } = useParams();
  const user = getUser()!;
  const nav = useNavigate();
  const [info, setInfo] = useState<PagesInfo | null>(null);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [zoom, setZoom] = useState(150);
  const [cuts, setCuts] = useState<Set<number>>(new Set());
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [rotations, setRotations] = useState<Record<number, number>>({});
  const [meta, setMeta] = useState<Record<number, PartMeta>>({});
  const [reasons, setReasons] = useState<Record<number, { reason: string; confidence: number }>>({});
  const [via, setVia] = useState<"manual" | "ai" | "separator">("manual");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState(false);

  const applySuggestion = useCallback((s: Suggestion) => {
    setCuts(new Set(s.cuts.map((c) => c.page)));
    setReasons(Object.fromEntries(s.cuts.map((c) => [c.page, { reason: c.reason, confidence: c.confidence }])));
    setMeta(Object.fromEntries(s.parts.map((p) => [p.from, p.documentType ? { documentType: p.documentType } : {}])));
    setVia("ai");
  }, []);

  useEffect(() => {
    let url: string | null = null;
    getPages(id, user._id)
      .then((p) => {
        setInfo(p);
        if (p.suggestion && p.splittable) applySuggestion(p.suggestion);
      })
      .catch((e) => setError(errorMessage(e, "Could not load the pages")));
    getPagesPdf(id, user._id)
      .then((b) => setPdfUrl((url = URL.createObjectURL(b))))
      .catch(() => {});
    getTaxonomy().then(setTax).catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, user._id, applySuggestion]);

  const pageCount = info?.pageCount || 0;
  const parts = useMemo(() => partsFromCuts(pageCount, cuts), [pageCount, cuts]);
  const liveParts = parts.filter((p) => keptPages(p, removed).length > 0);

  const toggleCut = (n: number) => {
    setCuts((c) => {
      const next = new Set(c);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
    if (via === "ai") setVia("manual");
  };
  const toggleRemoved = (n: number) =>
    setRemoved((r) => {
      const next = new Set(r);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const rotate = (n: number) => setRotations((r) => ({ ...r, [n]: ((r[n] || 0) + 90) % 360 }));
  const setPartMeta = (from: number, patch: PartMeta) => setMeta((m) => ({ ...m, [from]: { ...m[from], ...patch } }));

  const askAi = async () => {
    setBusy("ai");
    try {
      applySuggestion(await suggestSplit(id, user._id));
      message.success("Suggested cuts placed — check them before you split");
    } catch (e) {
      message.error(errorMessage(e, "Could not suggest cuts"));
    } finally {
      setBusy("");
    }
  };
  const useSeparators = () => {
    if (!info) return;
    const sepPages = info.pages.filter((p) => p.separator).map((p) => p.page);
    setRemoved(new Set(sepPages));
    setCuts(new Set(info.separatorParts.map((p) => p.from)));
    setMeta(Object.fromEntries(info.separatorParts.map((p) => [p.from, { documentType: p.prefill.documentType, employeeId: p.prefill.employeeId }])));
    setReasons({});
    setVia("separator");
  };
  const removeBlank = () => setRemoved((r) => new Set([...Array.from(r), ...(info?.pages.filter((p) => p.blank).map((p) => p.page) || [])]));

  const confirm = async () => {
    setBusy("split");
    try {
      const r = await splitFile(id, user._id, buildRequest(pageCount, cuts, removed, rotations, meta, via));
      message.success(`Split into ${r.parts.length} document${r.parts.length > 1 ? "s" : ""}`);
      nav(`/files/${id}`);
    } catch (e) {
      message.error(errorMessage(e, "Could not split"));
    } finally {
      setBusy("");
      setPreview(false);
    }
  };

  const typeOptions = tax?.categories.map((cat) => (
    <optgroup key={cat.key} label={cat.name}>
      {tax.documentTypes
        .filter((t) => t.categoryKey === cat.key && t.active !== false)
        .map((t) => (
          <option key={t.key} value={t.key}>
            {t.name}
          </option>
        ))}
    </optgroup>
  ));
  const thumb = (n: number, width: number) => (
    <Page pageNumber={n} width={width} rotate={rotations[n] || 0} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="split-thumb-ph" style={{ width, height: width * 1.29 }} />} />
  );

  if (error)
    return (
      <AppShell>
        <div className="card" style={{ padding: 24, color: "var(--danger)" }}>{error}</div>
      </AppShell>
    );
  if (!info)
    return (
      <AppShell>
        <div className="card" style={{ padding: 24 }}>Loading pages…</div>
      </AppShell>
    );

  const blanks = info.pages.filter((p) => p.blank).length;
  const seps = info.pages.filter((p) => p.separator).length;

  return (
    <AppShell>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Link to={`/files/${id}`} className="faint" style={{ fontSize: 13 }}>
            ← Back to the document
          </Link>
          <h1 style={{ margin: "4px 0 0" }}>Pages</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            {pageCount} pages · click between two pages to cut there. The original is kept and linked to the parts.
          </span>
        </div>
        <div className="split-toolbar" role="toolbar" aria-label="Page view tools">
          <button className="btn btn-sm" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(90, z - 30))}>
            −
          </button>
          <button className="btn btn-sm" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(330, z + 30))}>
            ＋
          </button>
          {info.splittable && (
            <>
              <button className="btn btn-sm" disabled={!!busy || pageCount < 2} onClick={askAi}>
                {busy === "ai" ? "Reading pages…" : "Suggest cuts with AI"}
              </button>
              {seps > 0 && (
                <button className="btn btn-sm" onClick={useSeparators}>
                  Cut at {seps} separator sheet{seps > 1 ? "s" : ""}
                </button>
              )}
              {blanks > 0 && (
                <button className="btn btn-sm" onClick={removeBlank}>
                  Remove {blanks} blank page{blanks > 1 ? "s" : ""}
                </button>
              )}
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setCuts(new Set());
                  setReasons({});
                  setVia("manual");
                }}
              >
                Clear cuts
              </button>
            </>
          )}
        </div>
      </div>
      {!info.splittable && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          This document can't be split: {info.reason?.toLowerCase()}.
        </div>
      )}

      <div className="split-layout">
        <div className="card split-grid-card">
          {pdfUrl ? (
            <Document file={pdfUrl} loading={<div style={{ padding: 24 }}>Loading pages…</div>} error={<div style={{ padding: 24 }}>The pages could not be shown.</div>}>
              <div className="split-grid">
                {info.pages.map((p) => {
                  const n = p.page;
                  const cut = cuts.has(n);
                  const r = reasons[n];
                  return (
                    <div key={n} className="split-cell">
                      {n > 1 && info.splittable && (
                        <button
                          className={`split-gutter${cut ? " on" : ""}`}
                          aria-pressed={cut}
                          aria-label={cut ? `Remove the cut before page ${n}` : `Cut before page ${n}`}
                          title={r ? `${r.reason} (${pct(r.confidence)} sure)` : cut ? "Remove this cut" : "Cut here"}
                          onClick={() => toggleCut(n)}
                        >
                          <span>✂</span>
                        </button>
                      )}
                      <figure className={`split-thumb${removed.has(n) ? " removed" : ""}`} style={{ width: zoom }}>
                        {thumb(n, zoom)}
                        <figcaption>
                          <span>p.{n}</span>
                          {p.separator && <span className="label">Separator</span>}
                          {p.blank && !p.separator && <span className="label">Blank</span>}
                          {info.splittable && (
                            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
                              <button className="btn btn-sm btn-ghost" aria-label={`Rotate page ${n}`} onClick={() => rotate(n)}>
                                ↻
                              </button>
                              <button className="btn btn-sm btn-ghost" aria-label={removed.has(n) ? `Keep page ${n}` : `Remove page ${n}`} onClick={() => toggleRemoved(n)}>
                                {removed.has(n) ? "↺" : "🗑"}
                              </button>
                            </span>
                          )}
                        </figcaption>
                      </figure>
                    </div>
                  );
                })}
              </div>
            </Document>
          ) : (
            <div style={{ padding: 24 }}>Loading pages…</div>
          )}
        </div>

        <aside>
          {info.splittable && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="card-header">
                Result: {liveParts.length} document{liveParts.length !== 1 ? "s" : ""}
              </div>
              <div style={{ padding: 12, display: "grid", gap: 12, fontSize: 13 }}>
                {liveParts.map((p, i) => {
                  const kept = keptPages(p, removed);
                  const m = meta[p.from] || {};
                  return (
                    <div key={p.from} className="inset" style={{ padding: 10, display: "grid", gap: 6 }}>
                      <strong>
                        Part {i + 1} · page{kept.length > 1 ? "s" : ""} {p.from === p.to ? p.from : `${p.from}–${p.to}`}
                        {kept.length !== p.to - p.from + 1 && <span className="faint"> ({kept.length} kept)</span>}
                      </strong>
                      {reasons[p.from] && <span className="faint">{reasons[p.from].reason}</span>}
                      <input aria-label={`Name of part ${i + 1}`} placeholder="Name (optional)" value={m.name || ""} onChange={(e) => setPartMeta(p.from, { name: e.target.value })} />
                      <select aria-label={`Document type of part ${i + 1}`} value={m.documentType || ""} onChange={(e) => setPartMeta(p.from, { documentType: e.target.value })}>
                        <option value="">Type: let the AI suggest</option>
                        {typeOptions}
                      </select>
                      <input aria-label={`Employee ID of part ${i + 1}`} placeholder="Employee ID (optional)" value={m.employeeId || ""} onChange={(e) => setPartMeta(p.from, { employeeId: e.target.value })} />
                    </div>
                  );
                })}
                <button className="btn btn-primary" disabled={!liveParts.length || !!busy} onClick={() => setPreview(true)}>
                  Preview split…
                </button>
              </div>
            </div>
          )}
          <SeparatorSheetCard tax={tax} />
        </aside>
      </div>

      {preview && pdfUrl && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Preview the split" onClick={() => setPreview(false)}>
          <div className="card compare-modal" style={{ maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header" style={{ display: "flex" }}>
              <span style={{ flex: 1 }}>
                {liveParts.length} document{liveParts.length !== 1 ? "s" : ""} will be created
                {removed.size > 0 && ` · ${removed.size} page${removed.size > 1 ? "s" : ""} left out`}
              </span>
              <button className="btn btn-sm" onClick={() => setPreview(false)}>
                Back
              </button>
            </div>
            <div style={{ padding: 14, maxHeight: "65vh", overflow: "auto", display: "grid", gap: 14 }}>
              <Document file={pdfUrl}>
                {liveParts.map((p, i) => {
                  const m = meta[p.from] || {};
                  const typeName = tax?.documentTypes.find((t) => t.key === m.documentType)?.name;
                  return (
                    <div key={p.from} style={{ marginBottom: 14 }}>
                      <strong>
                        {m.name || `Part ${i + 1}`}
                        {typeName && <span className="faint"> · {typeName}</span>}
                        {m.employeeId && <span className="faint"> · employee {m.employeeId}</span>}
                      </strong>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                        {keptPages(p, removed).map((n) => (
                          <div key={n} className="split-thumb small">
                            {thumb(n, 90)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </Document>
            </div>
            <div style={{ padding: 14, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-primary" disabled={busy === "split"} onClick={confirm}>
                {busy === "split" ? "Splitting…" : "Confirm split"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
