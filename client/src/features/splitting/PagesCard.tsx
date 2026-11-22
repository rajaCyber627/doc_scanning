import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { FileItem } from "../../api";

interface Lineage {
  splitInto: { fileId?: string; fileName?: string; status?: string; pages: number[]; restricted?: boolean }[];
  splitAt: string | null;
  splitFrom: { fileId?: string; fileName?: string; part: number; pages: number[]; restricted?: boolean } | null;
}
const range = (pages: number[]) => (pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`);

/** File page: where a part came from, what an original was split into, and the way into
 *  the page view (thumbnails, rotate, remove, split). */
export default function PagesCard({ file, userId }: { file: FileItem; userId: string }) {
  const [lin, setLin] = useState<Lineage | null>(null);
  const split = (file.splitInto?.length ?? 0) > 0;
  useEffect(() => {
    if (!split && !file.splitFrom) return setLin(null);
    axios
      .get(`/api/files/${file._id}/lineage`, { params: { userId } })
      .then((r) => setLin(r.data))
      .catch(() => setLin(null));
  }, [file._id, split, file.splitFrom, userId]);

  const canOpen = ["ready", "needs_review"].includes(file.status) && (/pdf/i.test(file.mimeType || "") || !!file.renditionS3Key);
  if (!canOpen && !split && !file.splitFrom) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">Pages</div>
      <div style={{ padding: 14, display: "grid", gap: 8, fontSize: 13 }}>
        {lin?.splitFrom && (
          <div>
            Part {lin.splitFrom.part} ({range(lin.splitFrom.pages)}) of{" "}
            {lin.splitFrom.fileId ? <Link to={`/files/${lin.splitFrom.fileId}`}>{lin.splitFrom.fileName}</Link> : "a restricted document"}
          </div>
        )}
        {split && (
          <div>
            <div style={{ marginBottom: 4 }}>Split into {file.splitInto!.length} documents. This original is kept for reference and is not filed itself.</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(lin?.splitInto || []).map((p, i) => (
                <li key={p.fileId || i}>
                  {p.fileId ? <Link to={`/files/${p.fileId}`}>{p.fileName}</Link> : "Restricted document"} <span className="faint">· {range(p.pages)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {canOpen && (
          <Link className="btn btn-sm" to={`/files/${file._id}/pages`} style={{ justifySelf: "start" }}>
            {split ? "View pages" : `View pages${(file.pageCount ?? 0) > 1 ? " · split" : ""}`}
          </Link>
        )}
      </div>
    </div>
  );
}
