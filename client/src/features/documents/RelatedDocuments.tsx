import { useNavigate } from "react-router-dom";
import { FileDetail } from "../../api";

/** Sidebar card: the email/archive a document came from, its attachments/contents,
 *  and anything that was not imported (with the reason). */
export default function RelatedDocuments({ detail }: { detail: FileDetail }) {
  const nav = useNavigate();
  const { parent, children, file } = detail;
  const skipped = file.childSummary?.skipped || [];
  if (!parent && !children.length && !skipped.length) return null;
  const isArchive = /\.zip$/i.test(file.fileName);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">{parent ? "Part of" : isArchive ? "Files in this archive" : "Attachments"}</div>
      <div style={{ padding: 10, display: "grid", gap: 6 }}>
        {parent && (
          <button className="btn btn-sm" style={{ justifyContent: "flex-start" }} onClick={() => nav(`/files/${parent._id}`)}>
            ↖ {parent.fileName}
          </button>
        )}
        {children.map((c) => (
          <button
            key={c._id}
            className="btn btn-sm related-doc"
            onClick={() => nav(`/files/${c._id}`)}
            title={c.error || c.fileName}
          >
            <span className="related-doc-name">📎 {c.fileName}</span>
            <span className={`badge ${c.status === "ready" ? "ready" : c.status === "failed" ? "failed" : "processing"}`}>
              <span className="dot" /> {c.status === "needs_review" ? "review" : c.status}
            </span>
          </button>
        ))}
        {skipped.length > 0 && (
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
            Not imported:
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {skipped.map((s, i) => (
                <li key={i}>
                  <strong>{s.name}</strong> — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
