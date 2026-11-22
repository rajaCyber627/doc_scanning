import { useState } from "react";
import { message } from "antd";
import { Taxonomy } from "../metadata/metadataApi";
import { errorMessage } from "../upload/uploadApi";
import { getSeparatorSheet } from "./splitApi";

/** Print separator sheets to put between documents before scanning. A sheet can carry a
 *  document type and employee ID, which then pre-fill the details of the next document. */
export default function SeparatorSheetCard({ tax }: { tax: Taxonomy | null }) {
  const [documentType, setType] = useState("");
  const [employeeId, setEmp] = useState("");
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const blob = await getSeparatorSheet({ documentType: documentType || undefined, employeeId: employeeId.trim() || undefined, copies });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) {
        const a = document.createElement("a");
        a.href = url;
        a.download = "separator-sheet.pdf";
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      message.error(errorMessage(e, "Could not make the sheet"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">Separator sheets</div>
      <div style={{ padding: 12, display: "grid", gap: 8, fontSize: 13 }}>
        <span className="faint">Print one and place it in front of each document in a stack. Scanned files are cut at these sheets automatically, and the sheets are removed.</span>
        <select aria-label="Separator document type" value={documentType} onChange={(e) => setType(e.target.value)}>
          <option value="">Any document type</option>
          {tax?.categories.map((cat) => (
            <optgroup key={cat.key} label={cat.name}>
              {tax.documentTypes
                .filter((t) => t.categoryKey === cat.key && t.active !== false)
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <input aria-label="Separator employee ID" placeholder="Employee ID (optional)" value={employeeId} onChange={(e) => setEmp(e.target.value)} />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Copies
          <input type="number" min={1} max={100} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} style={{ width: 70 }} />
        </label>
        <button className="btn btn-sm" disabled={busy} onClick={open}>
          {busy ? "Preparing…" : "Print separator sheet"}
        </button>
      </div>
    </div>
  );
}
