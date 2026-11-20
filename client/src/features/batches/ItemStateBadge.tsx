import { ItemState } from "./batchApi";

const LOOK: Record<ItemState, { cls: string; label: string }> = {
  not_uploaded: { cls: "", label: "Not uploaded" },
  uploading: { cls: "processing", label: "Uploading" },
  upload_failed: { cls: "failed", label: "Upload failed" },
  processing: { cls: "processing", label: "Processing" },
  ready: { cls: "ready", label: "Ready" },
  needs_review: { cls: "review", label: "Needs review" },
  failed: { cls: "failed", label: "Failed" },
  cancelled: { cls: "", label: "Cancelled" },
};

export default function ItemStateBadge({ state, stage }: { state: ItemState; stage?: string | null }) {
  const look = LOOK[state] || { cls: "", label: state };
  const stageText = state === "processing" && stage ? ` · ${stage}` : "";
  return (
    <span className={`badge ${look.cls}`}>
      <span className="dot" /> {look.label}
      {stageText}
    </span>
  );
}
