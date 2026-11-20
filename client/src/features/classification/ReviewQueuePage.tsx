import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import dayjs from "dayjs";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";

interface Item {
  fileId: string;
  fileName: string;
  uploadedAt: string;
  documentTypeName: string | null;
  confidence: number | null;
  person: string | null;
  reasons: string[];
}

/** Documents whose AI-suggested details wait for a person. Restricted records
 *  (medical, FMLA, ADA, WC, ER) have their own queue for permitted staff. */
export default function ReviewQueuePage() {
  const user = getUser()!;
  const nav = useNavigate();
  const canRestricted = user.role === "admin" || (user.permissions || []).some((p) => p === "restricted" || p === "admin");
  const [queue, setQueue] = useState<"general" | "restricted">("general");
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    axios
      .get("/api/review-queue", { params: { userId: user._id, queue } })
      .then((r) => {
        setItems(r.data);
        setError("");
      })
      .catch((e) => setError(e?.response?.data?.message || "Could not load the queue"));
  }, [user._id, queue]);
  useEffect(load, [load]);

  return (
    <AppShell>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0 }}>Review queue</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            Check the details the AI suggested, then accept or correct them. Nothing is filed until you do.
          </span>
        </div>
        {canRestricted && (
          <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }} role="tablist">
            {(["general", "restricted"] as const).map((q) => (
              <button
                key={q}
                role="tab"
                aria-selected={queue === q}
                className="btn btn-sm"
                style={{ border: "none", borderRadius: 0, background: queue === q ? "var(--overlay)" : "transparent" }}
                onClick={() => setQueue(q)}
              >
                {q === "general" ? "General" : "Restricted"}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <div className="card" style={{ padding: 16, color: "var(--danger)" }}>{error}</div>}
      {!items ? (
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Nothing to review.</div>
      ) : (
        <div className="list">
          {items.map((it) => (
            <div key={it.fileId} className="row clickable" onClick={() => nav(`/files/${it.fileId}`)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.fileName}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {it.documentTypeName || "Type not sure"} · {it.person || "person not found"} · {dayjs(it.uploadedAt).format("MMM D, h:mm A")}
                </div>
              </div>
              {typeof it.confidence === "number" && <span className="label">{Math.round(it.confidence * 100)}% sure</span>}
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
