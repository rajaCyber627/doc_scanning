import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { message } from "antd";
import dayjs from "dayjs";
import AppShell from "../components/AppShell";
import Chatbot from "../components/Chatbot";
import LoadingMessages from "../components/LoadingMessages";
import { getUser } from "../auth";
import { useUploads } from "../features/upload/useUploads";
import UploadTray from "../features/upload/UploadTray";
import { getUploadConfig, UploadConfig, errorMessage } from "../features/upload/uploadApi";
import { startBatchUpload } from "../features/batches/startBatchUpload";
import DocumentStatus from "../features/intake/DocumentStatus";
import Highlighted from "../features/search/Highlighted";
import BulkEditModal from "../features/metadata/BulkEditModal";
import MergeModal from "../features/merging/MergeModal";
import DropZone, { BrowseButtons, DropTargetInfo, useDropTarget, useDropZone } from "../features/upload/DropZone";
import {
  listFiles,
  listFolders,
  createFolder,
  deleteFile,
  deleteFolder,
  searchContent,
  FileItem,
  FolderItem,
  ContentHit,
} from "../api";

// Processed documents can be opened and asked about, including ones awaiting review.
const isUsable = (f: { status: string }) => f.status === "ready" || f.status === "needs_review";

export default function Documents() {
  const user = getUser()!;
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [uploadCfg, setUploadCfg] = useState<UploadConfig | null>(null);
  const [bulkEdit, setBulkEdit] = useState(false);
  const [merging, setMerging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<{ ids: string[]; label: string; folderId?: string } | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);
  const [setName, setSetName] = useState("");
  const [mode, setMode] = useState<"names" | "content">("names");
  const [hits, setHits] = useState<ContentHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const q = sp.get("q") || "";
  const setQ = (v: string) => setSp(v ? { q: v } : {}, { replace: true });

  const load = useCallback(() => {
    Promise.all([listFiles(user._id), listFolders(user._id)])
      .then(([f, fo]) => {
        setFiles(f);
        setFolders(fo);
        setExpanded((e) => (e.size ? e : new Set(fo.map((x) => x._id))));
      })
      .catch(() => {});
  }, [user._id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    getUploadConfig().then(setUploadCfg).catch(() => {});
  }, []);
  const uploads = useUploads(user._id, load);
  const maxMB = uploadCfg ? Math.round(uploadCfg.maxBytes / 1048576) : 100;
  useEffect(() => {
    if (!files.some((f) => f.status === "processing")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [files, load]);
  useEffect(() => {
    if (mode !== "content" || !q.trim()) {
      setHits(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      searchContent(user._id, q.trim())
        .then(setHits)
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [mode, q, user._id]);

  // Upload into folderId (or the user's root when omitted). Size/type checks and
  // per-file progress are handled by the upload queue (features/upload).
  const pushFiles = useCallback(
    (list: File[], folderId?: string) => uploads.enqueue(list, folderId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploads.enqueue]
  );

  // Several files are uploaded as one tracked batch (progress, retry, report).
  const [lastBatch, setLastBatch] = useState<{ id: string; name: string } | null>(null);
  const uploadAsBatch = async (files: File[], opts: { name?: string; folderId?: string }) => {
    try {
      const batch = await startBatchUpload(uploads.enqueue, user._id, files, opts);
      if (batch) setLastBatch({ id: batch._id, name: batch.name });
    } catch (e) {
      message.error(errorMessage(e, "Could not start the upload"));
    }
  };

  // Main dropzone / Upload button: one file → root; several → ask whether to
  // make a set or drop them all at root.
  const beginUpload = (list: File[]) => {
    if (!list.length) return;
    if (list.length > 1) setPending(list);
    else pushFiles(list);
  };
  const createSet = async () => {
    const files = pending || [];
    const name = setName.trim();
    setPending(null);
    setSetName("");
    try {
      const folder = await createFolder(user._id, name);
      await uploadAsBatch(files, { name: name || undefined, folderId: folder._id });
    } catch {
      message.error("Could not create the set");
    }
  };
  const uploadToRoot = () => {
    const files = pending || [];
    const name = setName.trim();
    setPending(null);
    setSetName("");
    uploadAsBatch(files, { name: name || undefined });
  };

  // Everything dropped or picked arrives here (already validated by DropZone).
  // Dropped/picked onto a set → added to that set; elsewhere → root (or a new set).
  const handleFiles = (list: File[], target: DropTargetInfo) => {
    if (target.folderId) {
      if (list.length > 1) uploadAsBatch(list, { folderId: target.folderId });
      else pushFiles(list, target.folderId);
    } else beginUpload(list);
  };

  // group + filter
  const match = (f: FileItem) => f.fileName.toLowerCase().includes(q.toLowerCase());
  const byFolder = useMemo(() => {
    const m = new Map<string, FileItem[]>();
    files.filter(match).forEach((f) => {
      const k = f.folderId || "__root__";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, q]);
  const rootFiles = byFolder.get("__root__") || [];

  const readyIds = (fs: FileItem[]) => fs.filter((f) => isUsable(f)).map((f) => f._id);
  const allVisibleReady = useMemo(
    () => readyIds(files.filter(match)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, q]
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleMany = (ids: string[]) =>
    setSelected((s) => {
      const n = new Set(s);
      const allOn = ids.length > 0 && ids.every((i) => n.has(i));
      ids.forEach((i) => (allOn ? n.delete(i) : n.add(i)));
      return n;
    });
  const toggleExpand = (id: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const removeFile = async (e: React.MouseEvent, f: FileItem) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${f.fileName}"?`)) return;
    try {
      await deleteFile(f._id);
      setFiles((s) => s.filter((x) => x._id !== f._id));
    } catch {
      message.error("Could not delete");
    }
  };
  const removeFolder = async (e: React.MouseEvent, folder: FolderItem) => {
    e.stopPropagation();
    if (!window.confirm(`Delete the set "${folder.name}" and all its files?`)) return;
    try {
      await deleteFolder(folder._id);
      load();
    } catch {
      message.error("Could not delete");
    }
  };

  const FileRow = (f: FileItem, indent: boolean) => (
    <div key={f._id} className="row" style={indent ? { paddingLeft: 34 } : undefined}>
      <input
        type="checkbox"
        style={{ width: "auto" }}
        checked={selected.has(f._id)}
        disabled={!isUsable(f)}
        onChange={() => toggle(f._id)}
        onClick={(e) => e.stopPropagation()}
      />
      <span
        style={{ flex: 1, minWidth: 0, cursor: isUsable(f) ? "pointer" : "default" }}
        onClick={() => isUsable(f) && nav(`/files/${f._id}`)}
      >
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
          📄 {f.fileName}
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {dayjs(f.createdAt).format("MMM D, YYYY")}
        </span>
      </span>
      {isUsable(f) && f.metadataStatus !== "complete" && (
        <span className="label" title="Document type, employee and other required details are not filled in yet">details missing</span>
      )}
      <DocumentStatus doc={f} userId={user._id} onRetried={load} />
      <button className="btn btn-sm btn-danger" onClick={(e) => removeFile(e, f)} title="Delete">
        ✕
      </button>
    </div>
  );

  return (
    <AppShell>
      <DropZone onFiles={handleFiles} defaultTarget={{ label: "your documents" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Documents</h1>
            <span className="faint" style={{ fontSize: 13 }}>
              Drag files or a folder anywhere · drop on a set to add to it · up to {maxMB} MB each
            </span>
          </div>
          <BrowseButtons compact />
        </div>

        <div className="card" style={{ display: "flex", gap: 8, padding: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          <input placeholder={mode === "content" ? 'Search inside documents — try "exact phrase" or -exclude' : "Search files…"} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260, height: 30 }} />
          <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
            <button className="btn btn-sm" style={{ border: "none", borderRadius: 0, background: mode === "names" ? "var(--overlay)" : "transparent" }} onClick={() => setMode("names")}>
              Names
            </button>
            <button className="btn btn-sm" style={{ border: "none", borderRadius: 0, background: mode === "content" ? "var(--overlay)" : "transparent" }} onClick={() => setMode("content")}>
              Content
            </button>
          </div>
          <button className="btn btn-sm" onClick={() => toggleMany(allVisibleReady)}>
            {allVisibleReady.length > 0 && allVisibleReady.every((i) => selected.has(i)) ? "Clear all" : "Select all"}
          </button>
          {selected.size > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
              Deselect ({selected.size})
            </button>
          )}
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: "auto" }}
            disabled={selected.size === 0}
            onClick={() => setAsk({ ids: Array.from(selected), label: `${selected.size} file${selected.size > 1 ? "s" : ""}` })}
          >
            💬 Ask {selected.size || ""} selected
          </button>
          <button className="btn btn-sm" disabled={selected.size === 0} onClick={() => setBulkEdit(true)}>
            ✎ Edit details{selected.size ? ` (${selected.size})` : ""}
          </button>
          <button className="btn btn-sm" disabled={selected.size < 2} title="Combine the selected documents (or some of their pages) into one" onClick={() => setMerging(true)}>
            ⧉ Merge{selected.size >= 2 ? ` (${selected.size})` : ""}
          </button>
        </div>

        {mode === "content" && q.trim() ? (
          searching ? (
            <div className="card" style={{ padding: 20 }}>
              <LoadingMessages compact />
            </div>
          ) : !hits || hits.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>
              No documents contain “{q}”.
            </div>
          ) : (
            <div className="list">
              {hits.map((h) => (
                <div key={h.fileId} className="row clickable" onClick={() => nav(`/files/${h.fileId}`)}>
                  <span>▤</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {h.fileName}
                    </div>
                    {h.snippet && (
                      <div className="faint search-snippet">
                        <Highlighted text={h.snippet} ranges={h.highlights} />
                      </div>
                    )}
                  </div>
                  {h.page ? <span className="label">page {h.page}</span> : null}
                  {h.count > 0 && <span className="label">{h.count} hit{h.count === 1 ? "" : "s"}</span>}
                </div>
              ))}
            </div>
          )
        ) : files.length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
            No documents yet. Drop files anywhere here or click <strong>Upload files</strong>.
          </div>
        ) : (
          <div className="list">
            {folders.map((folder) => {
              const fs = byFolder.get(folder._id) || [];
              if (q && fs.length === 0) return null;
              const ids = readyIds(fs);
              const isOpen = expanded.has(folder._id);
              return (
                <div key={folder._id}>
                  <FolderDropRow folderId={folder._id} label={folder.name}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={ids.length > 0 && ids.every((i) => selected.has(i))}
                      disabled={ids.length === 0}
                      onChange={() => toggleMany(ids)}
                    />
                    <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="faint" style={{ cursor: "pointer" }} onClick={() => toggleExpand(folder._id)}>
                        {isOpen ? "▾" : "▸"}
                      </span>
                      <span
                        style={{ fontWeight: 600, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        onClick={() => nav(`/folders/${folder._id}`)}
                        title="Open set"
                      >
                        📁 {folder.name}
                      </span>
                      <span className="label">{fs.length}</span>
                    </span>
                    <AddToFolderButton folderId={folder._id} label={folder.name} />
                    <button
                      className="btn btn-sm"
                      disabled={ids.length === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAsk({ ids, label: folder.name, folderId: folder._id });
                      }}
                    >
                      💬 Ask set
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={(e) => removeFolder(e, folder)} title="Delete set">
                      ✕
                    </button>
                  </FolderDropRow>
                  {isOpen && fs.map((f) => FileRow(f, true))}
                </div>
              );
            })}
            {rootFiles.map((f) => FileRow(f, false))}
            {q && rootFiles.length === 0 && folders.every((fo) => (byFolder.get(fo._id) || []).length === 0) && (
              <div className="row" style={{ color: "var(--muted)" }}>
                No files match "{q}".
              </div>
            )}
          </div>
        )}
      </DropZone>

      {merging && <MergeModal userId={user._id} fileIds={Array.from(selected)} onClose={() => setMerging(false)} />}
      {bulkEdit && <BulkEditModal userId={user._id} fileIds={Array.from(selected)} onClose={() => setBulkEdit(false)} onDone={load} />}

      <UploadTray
        items={uploads.items}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onDismiss={uploads.dismiss}
        onClear={uploads.clearFinished}
        footer={
          lastBatch && (
            <a href={`/batches/${lastBatch.id}`} onClick={(e) => { e.preventDefault(); nav(`/batches/${lastBatch.id}`); }}>
              View batch progress →
            </a>
          )
        }
      />

      {pending && (
        <div
          onClick={() => {
            setPending(null);
            setSetName("");
          }}
          style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.7)", zIndex: 100, display: "grid", placeItems: "center", padding: 24 }}
        >
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: "100%" }}>
            <div className="card-header">Upload {pending.length} files as a batch</div>
            <div style={{ padding: 16 }}>
              <label>Name (optional)</label>
              <input
                autoFocus
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createSet()}
                placeholder="e.g. 2024 Invoices"
                style={{ marginTop: 4, marginBottom: 6 }}
              />
              <div className="faint" style={{ fontSize: 12, marginBottom: 14 }}>
                Group them into a set, or add them to the root. Either way the upload is tracked as a batch (see Batches).
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn btn-primary" onClick={createSet}>
                  Create set
                </button>
                <button className="btn" onClick={uploadToRoot}>
                  Upload to root
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ marginLeft: "auto" }}
                  onClick={() => {
                    setPending(null);
                    setSetName("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {ask && (
        <div
          onClick={() => setAsk(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.7)", zIndex: 100, display: "grid", placeItems: "center", padding: 24 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 860 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, color: "#fff" }}>
              <strong>Ask · {ask.label}</strong>
              <button className="btn btn-sm" onClick={() => setAsk(null)}>Close</button>
            </div>
            <Chatbot fileIds={ask.ids} sourceLabel={ask.label} folderId={ask.folderId} onSaved={() => {}} height="72vh" />
          </div>
        </div>
      )}
    </AppShell>
  );
}

/** A set's header row that also accepts dropped files (adds them to that set). */
function FolderDropRow({ folderId, label, children }: { folderId: string; label: string; children: React.ReactNode }) {
  const { active, props } = useDropTarget({ folderId, label });
  return (
    <div
      className={"row" + (active ? " drop-active" : "")}
      style={{ background: "var(--canvas)" }}
      aria-label={`Set ${label} — drop files here to add them`}
      {...props}
    >
      {children}
    </div>
  );
}

function AddToFolderButton({ folderId, label }: { folderId: string; label: string }) {
  const { openFiles } = useDropZone();
  return (
    <button
      className="btn btn-sm"
      onClick={(e) => {
        e.stopPropagation();
        openFiles({ folderId, label });
      }}
      title="Add files to this set"
      aria-label={`Add files to ${label}`}
    >
      ＋ Add
    </button>
  );
}
