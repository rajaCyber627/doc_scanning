import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { errorMessage } from "../upload/uploadApi";
import { exportTaxonomy, getTaxonomy, importTaxonomy, saveDocumentType, DocType, FieldDef, Taxonomy } from "./metadataApi";

const TYPES: FieldDef["type"][] = ["text", "number", "date", "select"];
const blankType = (categoryKey: string): DocType => ({ key: "", name: "", categoryKey, defaultConfidentiality: "Confidential", defaultRetentionCategory: "", fields: [], active: true, order: 0 });

/** Admin: record categories, document types and their fields; JSON import/export. */
export default function TaxonomyPage() {
  const user = getUser()!;
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [editing, setEditing] = useState<DocType | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => getTaxonomy(true).then(setTax).catch(() => message.error("Could not load the taxonomy")), []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    try {
      await saveDocumentType(user._id, editing);
      message.success("Document type saved");
      setEditing(null);
      setProblems([]);
      load();
    } catch (e: any) {
      setProblems(e?.response?.data?.details || []);
      message.error(errorMessage(e, "Could not save"));
    }
  };
  const download = async () => {
    const data = await exportTaxonomy();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "hr-taxonomy.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const mode = window.confirm("Replace the whole list? OK = replace (types not in the file are deactivated), Cancel = merge") ? "replace" : "merge";
      const r = await importTaxonomy(user._id, data, mode);
      message.success(`Imported ${r.documentTypes} document types (${r.mode})`);
      load();
    } catch (err: any) {
      setProblems(err?.response?.data?.details || []);
      message.error(errorMessage(err, "Could not import that file"));
    }
  };
  const setField = (i: number, patch: Partial<FieldDef>) =>
    setEditing((t) => (t ? { ...t, fields: t.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) } : t));

  return (
    <AppShell>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onImport} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0 }}>Document types</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            Record categories, document types and the details each one needs. Only administrators can change them.
          </span>
        </div>
        <button className="btn btn-sm" onClick={download}>
          Export JSON
        </button>
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
          Import JSON
        </button>
      </div>
      {problems.length > 0 && (
        <div className="card drop-rejected" role="alert">
          <strong>Please fix:</strong>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {!tax ? (
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : (
        tax.categories.map((c) => (
          <div key={c.key} className="card" style={{ marginBottom: 12 }}>
            <div className="card-header" style={{ display: "flex", gap: 8 }}>
              <span style={{ flex: 1 }}>
                {c.name} <span className="faint" style={{ fontWeight: 400 }}>· default {c.defaultConfidentiality}</span>
              </span>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setEditing(blankType(c.key));
                  setIsNew(true);
                  setProblems([]);
                }}
              >
                ＋ Add type
              </button>
            </div>
            <div className="list" style={{ border: "none" }}>
              {tax.documentTypes
                .filter((t) => t.categoryKey === c.key)
                .map((t) => (
                  <div key={t.key} className="row">
                    <span style={{ flex: 1 }}>
                      {t.name}
                      {t.fields.length > 0 && <span className="faint"> · {t.fields.map((f) => f.label + (f.required ? "*" : "")).join(", ")}</span>}
                    </span>
                    <span className="label">{t.defaultConfidentiality}</span>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setEditing(JSON.parse(JSON.stringify(t)));
                        setIsNew(false);
                        setProblems([]);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                ))}
            </div>
          </div>
        ))
      )}

      {editing && tax && (
        <div className="modal-backdrop" onClick={() => setEditing(null)} role="dialog" aria-modal="true" aria-label="Edit document type">
          <div className="card compare-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <span>{isNew ? "New document type" : `Edit · ${editing.name}`}</span>
              <button className="btn btn-sm" onClick={() => setEditing(null)}>
                Close
              </button>
            </div>
            <div className="md-form">
              {isNew && (
                <div className="md-field">
                  <label htmlFor="tt-key">Key (e.g. training-and-development.cdl)</label>
                  <input id="tt-key" value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} />
                </div>
              )}
              <div className="md-field">
                <label htmlFor="tt-name">Name</label>
                <input id="tt-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="md-field">
                <label htmlFor="tt-conf">Default confidentiality</label>
                <select id="tt-conf" value={editing.defaultConfidentiality} onChange={(e) => setEditing({ ...editing, defaultConfidentiality: e.target.value })}>
                  {tax.confidentialityLevels.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="md-field">
                <label htmlFor="tt-ret">Default retention category</label>
                <input id="tt-ret" value={editing.defaultRetentionCategory} onChange={(e) => setEditing({ ...editing, defaultRetentionCategory: e.target.value })} />
              </div>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active
              </label>
              <strong style={{ marginTop: 6 }}>Extra details for this type</strong>
              {editing.fields.map((f, i) => (
                <div key={i} className="tt-field-row">
                  <input aria-label="Field key" placeholder="key" value={f.key} onChange={(e) => setField(i, { key: e.target.value })} />
                  <input aria-label="Field label" placeholder="label" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  <select aria-label="Field type" value={f.type} onChange={(e) => setField(i, { type: e.target.value as FieldDef["type"] })}>
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  {f.type === "select" && (
                    <input aria-label="Options" placeholder="options, comma separated" value={(f.options || []).join(", ")} onChange={(e) => setField(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                  )}
                  <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                    <input type="checkbox" style={{ width: "auto" }} checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> required
                  </label>
                  <button className="btn btn-sm btn-ghost" aria-label="Remove field" onClick={() => setEditing({ ...editing, fields: editing.fields.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setEditing({ ...editing, fields: [...editing.fields, { key: "", label: "", type: "text", required: false }] })}>
                ＋ Add detail
              </button>
              <div>
                <button className="btn btn-sm btn-primary" onClick={save}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
