import { useState } from "react";
import { message } from "antd";
import axios from "axios";
import { FileItem } from "../../api";
import { errorMessage } from "../upload/uploadApi";

/** Sidebar card: what OCR found (quality, form fields) and the review action. */
export default function OcrPanel({ file, userId, onChanged }: { file: FileItem; userId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const reasons = file.reviewReasons || [];
  const ocr = file.ocr;
  if (!ocr && !reasons.length) return null;

  const markReviewed = async () => {
    setBusy(true);
    try {
      await axios.post(`/api/files/${file._id}/review`, { userId });
      message.success("Marked as reviewed");
      onChanged();
    } catch (e) {
      message.error(errorMessage(e, "Could not save the review"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">Text recognition</div>
      <div style={{ padding: 14, display: "grid", gap: 10, fontSize: 13 }}>
        {file.status === "needs_review" && reasons.length > 0 && (
          <div className="review-box" role="status">
            <strong>Needs review</strong>
            <ul>
              {reasons.map((r, i) => (
                <li key={i}>{r.message}</li>
              ))}
            </ul>
            <button className="btn btn-sm btn-primary" onClick={markReviewed} disabled={busy}>
              {busy ? "Saving…" : "I checked it — mark as reviewed"}
            </button>
          </div>
        )}
        {ocr && (
          <div className="faint">
            {ocr.pages} page{ocr.pages === 1 ? "" : "s"} read
            {typeof ocr.avgConfidence === "number" ? ` · ${Math.round(ocr.avgConfidence)}% average confidence` : ""}
            {ocr.corrected ? " · straightened before reading" : ""}
          </div>
        )}
        {ocr && ocr.keyValues && ocr.keyValues.length > 0 && (
          <div>
            <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
              Form fields found
            </div>
            <dl className="kv-list">
              {ocr.keyValues.slice(0, 30).map((kv, i) => (
                <div key={i} className="kv-row">
                  <dt>{kv.key}</dt>
                  <dd>{kv.value || <span className="faint">(empty)</span>}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
