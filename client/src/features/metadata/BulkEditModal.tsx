import { useEffect, useState } from "react";
import { message } from "antd";
import { errorMessage } from "../upload/uploadApi";
import PersonPicker from "./PersonPicker";
import { bulkMetadata, getTaxonomy, BulkResult, Metadata, Taxonomy } from "./metadataApi";

const FIELD_LABELS: Record<string, string> = {
  documentType: "Document type",
  employeeName: "Employee",
  employeeId: "Employee ID",
  effectiveDate: "Effective date",
  creationDate: "Document date",
  fiscalYear: "Fiscal year",
  confidentialityLevel: "Confidentiality",
  status: "Record status",
  caseNumber: "Case number",
};

/** Set the same details on many documents: preview the changes, then apply. */
export default function BulkEditModal({ userId, fileIds, onClose, onDone }: { userId: string; fileIds: string[]; onClose: () => void; onDone: () => void }) {
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [set, setSet] = useState<Metadata>({});
  const [person, setPerson] = useState<Metadata>({});
  const [preview, setPreview] = useState<BulkResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getTaxonomy().then(setTax).catch(() => {});
  }, []);

  const values = (): Metadata => {
    const v: Metadata = {};
    Object.entries(set).forEach(([k, val]) => val !== "" && val !== undefined && (v[k] = val));
    if (person.personId) v.personId = person.personId;
    return v;
  };
  const run = async (apply: boolean) => {
    const v = values();
    if (!Object.keys(v).length) return message.warning("Choose at least one detail to set");
    setBusy(true);
    try {
      const r = await bulkMetadata(userId, fileIds, v, apply);
      if (!apply) setPreview(r.results);
      else {
        const done = r.results.filter((x) => !x.error).length;
        message.success(`Updated ${done} document${done === 1 ? "" : "s"}`);
        onDone();
        onClose();
      }
    } catch (e) {
      message.error(errorMessage(e, "Could not update the documents"));
    } finally {
      setBusy(false);
    }
  };
  const field = (key: string, el: JSX.Element) => (
    <div className="md-field">
      <label htmlFor={`bulk-${key}`}>{FIELD_LABELS[key] || key}</label>
      {el}
    </div>
  );
  const bind = (key: string) => ({
    id: `bulk-${key}`,
    value: set[key] || "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setSet((s) => ({ ...s, [key]: e.target.value }));
      setPreview(null);
    },
  });

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Edit details of several documents">
      <div className="card compare-modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <span>Edit details · {fileIds.length} documents</span>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="md-form" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {field(
            "documentType",
            <select {...bind("documentType")}>
              <option value="">(leave as is)</option>
              {tax?.categories.map((c) => (
                <optgroup key={c.key} label={c.name}>
                  {tax.documentTypes
                    .filter((t) => t.categoryKey === c.key)
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
          <div className="md-field">
            <label htmlFor="bulk-person">Employee / applicant</label>
            <PersonPicker
              id="bulk-person"
              value={person}
              onPick={(p) => {
                setPerson({ personId: p.personId, employeeName: p.name, employeeId: p.employeeId || "", applicantNumber: p.applicantNumber || "" });
                setPreview(null);
              }}
            />
          </div>
          {field("effectiveDate", <input type="date" {...bind("effectiveDate")} />)}
          {field("creationDate", <input type="date" {...bind("creationDate")} />)}
          {field("fiscalYear", <input placeholder="auto from date" {...bind("fiscalYear")} />)}
          {field(
            "confidentialityLevel",
            <select {...bind("confidentialityLevel")}>
              <option value="">(leave as is)</option>
              {tax?.confidentialityLevels.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          )}
          {field(
            "status",
            <select {...bind("status")}>
              <option value="">(leave as is)</option>
              {["Active", "Final", "Draft", "Inactive"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          )}
          {field("caseNumber", <input {...bind("caseNumber")} />)}
        </div>
        <div style={{ padding: "0 14px 14px", display: "flex", gap: 8 }}>
          <button className="btn btn-sm" disabled={busy} onClick={() => run(false)}>
            Preview changes
          </button>
          <button className="btn btn-sm btn-primary" disabled={busy || !preview} onClick={() => run(true)} title={preview ? "" : "Preview first"}>
            Apply to {fileIds.length} documents
          </button>
        </div>
        {preview && (
          <div style={{ padding: "0 14px 14px" }}>
            <div className="list">
              {preview.map((r) => (
                <div key={r.fileId} className="row" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{r.fileName || r.fileId}</strong>
                    {r.error ? (
                      <div className="md-error">{r.error}</div>
                    ) : r.changes && r.changes.length ? (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {r.changes
                          .filter((c) => FIELD_LABELS[c.field])
                          .map((c) => `${FIELD_LABELS[c.field]}: ${c.from ?? "—"} → ${c.to ?? "—"}`)
                          .join(" · ") || `${r.changes.length} field(s) change`}
                      </div>
                    ) : (
                      <div className="faint" style={{ fontSize: 12 }}>No change</div>
                    )}
                    {r.errors && r.errors.length > 0 && <div className="md-error">Still needed: {r.errors.map((e) => e.message).join("; ")}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
