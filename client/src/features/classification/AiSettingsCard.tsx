import { useEffect, useState } from "react";
import { message } from "antd";
import axios from "axios";
import { errorMessage } from "../upload/uploadApi";

interface Settings {
  aiEnabled: boolean;
  autoAccept: boolean;
  autoAcceptThreshold: number;
}
interface AccuracyRow {
  documentType: string | null;
  documents: number;
  typeAcceptance: number | null;
  fieldAcceptance: number | null;
}

/** Admin: AI on/off, auto-accept, and how often reviewers keep the AI's suggestions. */
export default function AiSettingsCard({ userId }: { userId: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [rows, setRows] = useState<AccuracyRow[]>([]);

  useEffect(() => {
    axios.get("/api/settings/classification").then((r) => setS(r.data)).catch(() => {});
    axios.get("/api/classification/accuracy", { params: { userId } }).then((r) => setRows(r.data)).catch(() => {});
  }, [userId]);

  const save = async (patch: Partial<Settings>) => {
    try {
      const r = await axios.put("/api/settings/classification", { userId, settings: patch });
      setS(r.data);
      message.success("AI settings saved");
    } catch (e) {
      message.error(errorMessage(e, "Could not save"));
    }
  };
  if (!s) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">AI suggestions</div>
      <div style={{ padding: 14, display: "grid", gap: 10, fontSize: 13 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={s.aiEnabled} onChange={(e) => save({ aiEnabled: e.target.checked })} />
          Suggest document type, person and details with AI. When off, staff enter details by hand and no document text is sent to the AI.
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={s.autoAccept} disabled={!s.aiEnabled} onChange={(e) => save({ autoAccept: e.target.checked })} />
          File very confident suggestions automatically (person matched by ID, every confidence at least
          <input
            type="number"
            min={0.5}
            max={1}
            step={0.01}
            value={s.autoAcceptThreshold}
            onChange={(e) => setS({ ...s, autoAcceptThreshold: Number(e.target.value) })}
            onBlur={() => save({ autoAcceptThreshold: s.autoAcceptThreshold })}
            style={{ width: 70 }}
            aria-label="Auto-accept threshold"
          />
          ). Off by default: a person reviews everything.
        </label>
        <div>
          <strong>Accuracy</strong> <span className="faint">(share of suggestions reviewers kept)</span>
          {rows.length === 0 ? (
            <div className="faint">No reviewed suggestions yet.</div>
          ) : (
            <table className="acc-table">
              <thead>
                <tr>
                  <th>Document type</th>
                  <th>Documents</th>
                  <th>Type kept</th>
                  <th>Details kept</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.documentType || "none"}>
                    <td>{r.documentType || "(none)"}</td>
                    <td>{r.documents}</td>
                    <td>{r.typeAcceptance === null ? "—" : `${Math.round(r.typeAcceptance * 100)}%`}</td>
                    <td>{r.fieldAcceptance === null ? "—" : `${Math.round(r.fieldAcceptance * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
