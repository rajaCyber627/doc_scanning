import { useState } from "react";
import { message } from "antd";
import { retryDocument, errorMessage } from "../upload/uploadApi";

// What each pipeline stage means to a user.
const STAGE_LABELS: Record<string, string> = {
  store: "Saving…",
  hash: "Checking file…",
  extract: "Reading text…",
  classify: "Classifying…",
  index: "Indexing…",
  handoff: "Finishing…",
};

export interface StatusDoc {
  _id: string;
  status: "processing" | "ready" | "needs_review" | "failed";
  stage?: string | null;
  error?: string;
  reviewReasons?: { message: string }[];
}

/** Status badge for a document: current step, ready, or the failure reason + Retry. */
export default function DocumentStatus({
  doc,
  userId,
  onRetried,
  showReason = true,
}: {
  doc: StatusDoc;
  userId: string;
  onRetried?: () => void;
  showReason?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  if (doc.status === "processing") {
    return (
      <span className="badge processing" aria-live="polite">
        <span className="dot" /> {STAGE_LABELS[doc.stage || ""] || "Processing…"}
      </span>
    );
  }
  if (doc.status === "needs_review") {
    return (
      <span className="doc-failed">
        <span className="badge review" title={doc.reviewReasons?.map((r) => r.message).join("\n") || "A person needs to check this document"}>
          <span className="dot" /> Needs review
        </span>
        {showReason && doc.reviewReasons?.[0] && <span className="doc-failed-reason" style={{ color: "var(--attention)" }}>{doc.reviewReasons[0].message}</span>}
      </span>
    );
  }
  if (doc.status === "ready") {
    return (
      <span className="badge ready">
        <span className="dot" /> Ready
      </span>
    );
  }

  const retry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await retryDocument(doc._id, userId);
      onRetried?.();
    } catch (err) {
      message.error(errorMessage(err, "Could not retry"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="doc-failed" onClick={(e) => e.stopPropagation()}>
      <span className="badge failed" title={doc.error || "Processing failed"}>
        <span className="dot" /> Failed
      </span>
      {showReason && doc.error && <span className="doc-failed-reason">{doc.error}</span>}
      <button className="btn btn-sm" onClick={retry} disabled={busy}>
        {busy ? "Retrying…" : "Retry"}
      </button>
    </span>
  );
}
