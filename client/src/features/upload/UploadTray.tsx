import { ReactNode } from "react";
import { UploadItem } from "./useUploads";

const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function statusText(it: UploadItem) {
  switch (it.phase) {
    case "queued":
      return "Waiting…";
    case "uploading":
      return `Uploading ${Math.round(it.progress * 100)}%`;
    case "verifying":
      return "Checking file…";
    case "done":
      return "Uploaded — reading document";
    case "cancelled":
      return "Cancelled";
    default:
      return "Failed";
  }
}

interface Props {
  items: UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
  footer?: ReactNode; // e.g. a link to the batch page
}

/** Bottom-right panel listing uploads with progress, errors, cancel and retry. */
export default function UploadTray({ items, onCancel, onRetry, onDismiss, onClear, footer }: Props) {
  if (!items.length) return null;
  const active = items.filter((i) => ["queued", "uploading", "verifying"].includes(i.phase)).length;
  return (
    <div className="upload-tray card" role="region" aria-label="Uploads" aria-live="polite">
      <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }}>{active ? `Uploading ${active} file${active > 1 ? "s" : ""}` : "Uploads"}</span>
        {!active && (
          <button className="btn btn-sm btn-ghost" onClick={onClear} aria-label="Close upload list">
            Close
          </button>
        )}
      </div>
      <div className="upload-tray-list">
        {items.map((it) => (
          <div key={it.id} className="upload-item">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="upload-name" title={it.file.name}>
                {it.file.name}
              </span>
              <span className="faint" style={{ fontSize: 12, flexShrink: 0 }}>
                {fmtSize(it.file.size)}
              </span>
            </div>
            {(it.phase === "uploading" || it.phase === "verifying" || it.phase === "queued") && (
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(it.progress * 100)}
                aria-label={`Upload progress for ${it.file.name}`}
              >
                <div className="progress-bar" style={{ width: `${Math.round(it.progress * 100)}%` }} />
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <span className={`upload-status ${it.phase}`}>{statusText(it)}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {["queued", "uploading"].includes(it.phase) && (
                  <button className="btn btn-sm btn-ghost" onClick={() => onCancel(it.id)}>
                    Cancel
                  </button>
                )}
                {it.phase === "failed" && (
                  <>
                    <button className="btn btn-sm" onClick={() => onRetry(it.id)}>
                      Retry
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => onDismiss(it.id)} aria-label={`Dismiss ${it.file.name}`}>
                      ✕
                    </button>
                  </>
                )}
              </span>
            </div>
            {it.phase === "failed" && it.error && <div className="upload-error">{it.error}</div>}
          </div>
        ))}
      </div>
      {footer && <div className="upload-tray-footer">{footer}</div>}
    </div>
  );
}
