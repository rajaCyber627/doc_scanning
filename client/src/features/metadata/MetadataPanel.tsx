import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import { errorMessage } from "../upload/uploadApi";
import PersonPicker from "./PersonPicker";
import { fieldsFor, getTaxonomy, nextIncomplete, saveMetadata, FieldDef, FieldError, Metadata, Taxonomy } from "./metadataApi";

const STATUS_TEXT: Record<string, string> = {
  complete: "Complete",
  incomplete: "Missing required details",
  missing: "No details yet",
};

/** Document details (standard HR metadata) beside the viewer. Ctrl/⌘+S saves,
 *  Ctrl/⌘+Enter saves and opens the next document that still needs details. */
export default function MetadataPanel({
  fileId,
  userId,
  initial,
  status,
  serverErrors,
  onSaved,
}: {
  fileId: string;
  userId: string;
  initial: Metadata;
  status?: string;
  serverErrors?: FieldError[];
  onSaved: () => void;
}) {
  const nav = useNavigate();
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [form, setForm] = useState<Metadata>(initial || {});
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>(serverErrors || []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTaxonomy().then(setTax).catch(() => message.error("Could not load document types"));
  }, []);
  // Take fresh server data when switching documents, or when there are no unsaved
  // edits (the page refreshes in the background — never wipe what someone is typing).
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const lastFile = useRef(fileId);
  const initialKey = JSON.stringify(initial || {});
  const errorsKey = JSON.stringify(serverErrors || []);
  useEffect(() => {
    const switched = lastFile.current !== fileId;
    lastFile.current = fileId;
    if (switched || !dirtyRef.current) {
      setForm(JSON.parse(initialKey));
      setErrors(JSON.parse(errorsKey));
      setDirty(false);
    }
  }, [fileId, initialKey, errorsKey]);

  const fields = useMemo(() => (tax ? fieldsFor(tax, form.documentType) : []), [tax, form.documentType]);
  const errorFor = (key: string) => errors.find((e) => e.field === key)?.message;
  const set = (key: string, value: any) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const save = useCallback(
    async (andNext: boolean) => {
      setSaving(true);
      try {
        const payload: Metadata = {};
        for (const f of fields) if (f.type !== "person" && f.key in form) payload[f.key] = form[f.key];
        if (form.personId !== (initial || {}).personId && form.personId) payload.personId = form.personId;
        const r = await saveMetadata(fileId, userId, payload);
        setErrors(r.errors);
        setForm(r.metadata);
        setDirty(false);
        onSaved();
        if (r.metadataStatus === "complete") message.success("Details saved");
        else message.warning(`Saved — ${r.errors.length} detail${r.errors.length === 1 ? "" : "s"} still needed`);
        if (andNext) {
          const next = await nextIncomplete(userId, fileId);
          if (next) nav(`/files/${next.fileId}`);
          else message.info("No more documents need details");
        }
      } catch (e) {
        message.error(errorMessage(e, "Could not save the details"));
      } finally {
        setSaving(false);
      }
    },
    [fields, form, initial, fileId, userId, onSaved, nav]
  );

  // keyboard shortcuts for fast keying
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        save(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!tax) return null;
  const byCategory = tax.categories.map((c) => ({ c, types: tax.documentTypes.filter((t) => t.categoryKey === c.key) }));

  const input = (f: FieldDef) => {
    const id = `md-${f.key}`;
    const err = errorFor(f.key);
    const common = { id, "aria-invalid": err ? true : undefined, "aria-describedby": err ? `${id}-err` : undefined };
    if (f.type === "doctype") {
      return (
        <select {...common} value={form.documentType || ""} onChange={(e) => set("documentType", e.target.value)}>
          <option value="">Choose…</option>
          {byCategory.map(({ c, types }) => (
            <optgroup key={c.key} label={c.name}>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      );
    }
    if (f.type === "person") {
      return (
        <PersonPicker
          id={id}
          value={form}
          invalid={!!err}
          onPick={(p) => {
            setForm((m) => ({ ...m, personId: p.personId, employeeName: p.name, employeeId: p.employeeId || "", applicantNumber: p.applicantNumber || "", positionTitle: p.positionTitle, department: p.department, division: p.division || "" }));
            setDirty(true);
          }}
        />
      );
    }
    if (f.type === "select") {
      return (
        <select {...common} value={form[f.key] || ""} onChange={(e) => set(f.key, e.target.value)}>
          <option value="">—</option>
          {(f.options || []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    }
    return (
      <input
        {...common}
        type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
        value={form[f.key] ?? ""}
        placeholder={f.type === "fiscalyear" ? "auto from date, e.g. FY2026" : undefined}
        onChange={(e) => set(f.key, e.target.value)}
      />
    );
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ flex: 1 }}>Document details</span>
        <span className={`badge ${status === "complete" ? "ready" : "review"}`}>
          <span className="dot" /> {STATUS_TEXT[status || "missing"]}
        </span>
      </div>
      <div className="md-form">
        {fields.map((f) => (
          <div key={f.key} className="md-field">
            <label htmlFor={`md-${f.key}`}>
              {f.label}
              {f.required && <span className="md-req" aria-label="required"> *</span>}
            </label>
            {input(f)}
            {errorFor(f.key) && (
              <div id={`md-${f.key}-err`} className="md-error">
                {errorFor(f.key)}
              </div>
            )}
          </div>
        ))}
        {form.recordCategory && <div className="faint" style={{ fontSize: 12 }}>Record category: {form.recordCategory}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => save(false)} title="Ctrl/⌘ + S">
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn btn-sm" disabled={saving} onClick={() => save(true)} title="Ctrl/⌘ + Enter">
            Save &amp; next
          </button>
          {dirty && <span className="faint" style={{ fontSize: 12, alignSelf: "center" }}>Unsaved changes</span>}
        </div>
      </div>
    </div>
  );
}
