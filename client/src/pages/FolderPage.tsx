import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { message } from "antd";
import dayjs from "dayjs";
import AppShell from "../components/AppShell";
import Chatbot from "../components/Chatbot";
import ResultView from "../components/ResultView";
import LoadingMessages from "../components/LoadingMessages";
import { getUser } from "../auth";
import { useUploads } from "../features/upload/useUploads";
import UploadTray from "../features/upload/UploadTray";
import { errorMessage } from "../features/upload/uploadApi";
import DropZone, { BrowseButtons } from "../features/upload/DropZone";
import { startBatchUpload } from "../features/batches/startBatchUpload";
import DocumentStatus from "../features/intake/DocumentStatus";
import {
  getFolder,
  deleteFolder,
  deleteTable,
  FolderItem,
  FileItem,
  SavedTableItem,
} from "../api";

type Tab = "chat" | "tables" | "files";

export default function FolderPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [state, setState] = useState<{
    folder: FolderItem;
    files: FileItem[];
    tables: SavedTableItem[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("chat");
  const [modal, setModal] = useState<SavedTableItem | null>(null);
  const user = getUser()!;
  const [lastBatch, setLastBatch] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    return getFolder(id)
      .then(setState)
      .catch(() => message.error("Could not load this set"));
  }, [id]);
  useEffect(() => {
    setLoading(true);
    Promise.resolve(load()).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    if (!state?.files.some((f) => f.status === "processing")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [state, load]);

  const uploads = useUploads(user._id, () => {
    load();
  });
  // Dropped or picked files (already validated) are added to this set.
  const addFiles = (picked: File[]) => {
    if (!picked.length || !id) return;
    if (picked.length === 1) {
      uploads.enqueue(picked, id);
      return;
    }
    startBatchUpload(uploads.enqueue, user._id, picked, { folderId: id })
      .then((b) => b && setLastBatch(b._id))
      .catch((err) => message.error(errorMessage(err, "Could not start the upload")));
  };

  if (loading || !state)
    return (
      <AppShell>
        <div className="card" style={{ padding: 40 }}>
          <LoadingMessages />
        </div>
      </AppShell>
    );

  const { folder, files, tables } = state;
  const readyIds = files.filter((f) => f.status === "ready").map((f) => f._id);
  const processing = files.filter((f) => f.status === "processing").length;

  const removeTable = async (t: SavedTableItem) => {
    try {
      await deleteTable(t._id);
      setModal(null);
      load();
    } catch {
      message.error("Could not delete");
    }
  };
  const removeFolder = async () => {
    if (!window.confirm(`Delete the set "${folder.name}" and all its files?`)) return;
    try {
      await deleteFolder(folder._id);
      nav("/documents");
    } catch {
      message.error("Could not delete");
    }
  };

  return (
    <AppShell>
      <DropZone onFiles={addFiles} defaultTarget={{ folderId: folder._id, label: `“${folder.name}”` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <button className="btn btn-sm" onClick={() => nav("/documents")}>
          ← Documents
        </button>
        <h2 style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          📁 {folder.name}
        </h2>
        <span className="label">{files.length} files</span>
        <span style={{ marginLeft: "auto" }}>
          <BrowseButtons compact target={{ folderId: folder._id, label: folder.name }} />
        </span>
        <button className="btn btn-sm btn-danger" onClick={removeFolder}>
          Delete set
        </button>
      </div>
      <div className="faint" style={{ fontSize: 12, marginBottom: 18 }}>
        Created {dayjs(folder.createdAt).format("MMM D, YYYY · h:mm A")}
        {processing > 0 ? ` · ${processing} still processing` : ""}
      </div>

      <div className="tabs">
        <button className={"tab" + (tab === "chat" ? " active" : "")} onClick={() => setTab("chat")}>
          💬 Chat
        </button>
        <button className={"tab" + (tab === "tables" ? " active" : "")} onClick={() => setTab("tables")}>
          ▦ Saved tables <span className="label" style={{ marginLeft: 2 }}>{tables.length}</span>
        </button>
        <button className={"tab" + (tab === "files" ? " active" : "")} onClick={() => setTab("files")}>
          📄 Files <span className="label" style={{ marginLeft: 2 }}>{files.length}</span>
        </button>
      </div>

      {tab === "chat" &&
        (readyIds.length === 0 ? (
          <div className="card" style={{ padding: 26, color: "var(--muted)" }}>
            No ready files in this set yet. Once processing finishes you can ask across all of them.
          </div>
        ) : (
          <Chatbot
            fileIds={readyIds}
            sourceLabel={folder.name}
            folderId={folder._id}
            onSaved={load}
            height="72vh"
          />
        ))}

      {tab === "tables" &&
        (tables.length === 0 ? (
          <div className="card" style={{ padding: 26, color: "var(--muted)" }}>
            No saved tables from this set yet. Ask a question in <strong>Chat</strong>, then hit{" "}
            <strong>Save to DB</strong>.
          </div>
        ) : (
          <div className="list">
            {tables.map((t) => (
              <div key={t._id} className="row clickable" onClick={() => setModal(t)}>
                <span>▦</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title || t.query}
                  </div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {dayjs(t.createdAt).format("MMM D, h:mm A")}
                  </div>
                </div>
                <span className="faint" style={{ fontSize: 12 }}>view →</span>
              </div>
            ))}
          </div>
        ))}

      {tab === "files" && (
        <div className="list">
          {files.map((f) => (
            <div
              key={f._id}
              className={"row" + (f.status === "ready" ? " clickable" : "")}
              onClick={() => f.status === "ready" && nav(`/files/${f._id}`)}
            >
              <span>📄</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.fileName}
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {dayjs(f.createdAt).format("MMM D, YYYY")}
                </div>
              </div>
              <DocumentStatus doc={f} userId={user._id} onRetried={() => load()} />
            </div>
          ))}
        </div>
      )}

      <UploadTray
        items={uploads.items}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onDismiss={uploads.dismiss}
        onClear={uploads.clearFinished}
        footer={
          lastBatch && (
            <a href={`/batches/${lastBatch}`} onClick={(e) => { e.preventDefault(); nav(`/batches/${lastBatch}`); }}>
              View batch progress →
            </a>
          )
        }
      />

      {modal && (
        <div
          onClick={() => setModal(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.7)", zIndex: 100, display: "grid", placeItems: "center", padding: 24 }}
        >
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, width: "100%", maxHeight: "85vh", overflow: "auto" }}>
            <div className="card-header">
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{modal.title || modal.query}</span>
              <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button className="btn btn-sm" onClick={() => nav(`/tables/${modal._id}`)}>Open page</button>
                <button className="btn btn-sm btn-danger" onClick={() => removeTable(modal)}>Delete</button>
                <button className="btn btn-sm" onClick={() => setModal(null)}>Close</button>
              </span>
            </div>
            {modal.sourceFileNames && modal.sourceFileNames.length > 0 && (
              <div className="faint" style={{ fontSize: 12, padding: "10px 16px 0" }}>
                From {modal.sourceFileNames.length} files: {modal.sourceFileNames.join(", ")}
              </div>
            )}
            <div style={{ padding: 16 }}>
              <ResultView data={modal.data} />
            </div>
          </div>
        </div>
      )}
      </DropZone>
    </AppShell>
  );
}
