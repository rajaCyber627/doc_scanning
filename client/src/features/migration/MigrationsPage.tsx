import { useCallback, useEffect, useState } from "react";
import { message } from "antd";
import axios from "axios";
import dayjs from "dayjs";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { errorMessage } from "../upload/uploadApi";

interface Run {
  _id: string;
  name: string;
  status: string;
  source: { kind: string; label: string };
  createdAt: string;
  summary: {
    inventory?: { files: number; bytes: number; importable: number; likelyDuplicates: number; issues: Record<string, number>; byAge: Record<string, number> };
    mapping?: { mapped: number; unmapped: number; withProblems: number; byRule: Record<string, number> };
    migration?: { mode: string; imported: number; skipped: number; failed: number; at: string }[];
    reconciliation?: { source: number; imported: number; skipped: number; failed: number; pending: number; accountedFor: boolean; skippedBy: Record<string, number>; failedBy: Record<string, number>; verified: { match: number; mismatch: number; missing: number }; at: string };
  };
}
interface Detail {
  run: Run;
  items: Record<string, number>;
  unmapped: string[];
  failed: { path: string; reason: string }[];
}
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const STEP_LABEL: Record<string, string> = { created: "Created", inventoried: "Inventoried", mapped: "Mapped (dry run)", migrating: "Migrating", migrated: "Migrated", reconciled: "Reconciled", failed: "Failed" };

/** Admin: shared-drive / SharePoint migration runs (started from the CLI) and their reports. */
export default function MigrationsPage() {
  const user = getUser()!;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    axios
      .get("/api/migrations", { params: { userId: user._id } })
      .then((r) => setRuns(r.data))
      .catch((e) => setError(errorMessage(e, "Could not load migrations")));
  }, [user._id]);
  useEffect(load, [load]);

  const show = async (id: string) => {
    try {
      setOpen((await axios.get(`/api/migrations/${id}`, { params: { userId: user._id } })).data);
    } catch (e) {
      message.error(errorMessage(e, "Could not open the run"));
    }
  };
  const download = async (id: string, kind: string) => {
    try {
      const r = await axios.get(`/api/migrations/${id}/${kind}.csv`, { params: { userId: user._id }, responseType: "blob" });
      const name = decodeURIComponent(/filename="([^"]+)"/.exec(r.headers["content-disposition"] || "")?.[1] || `${kind}.csv`);
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      message.error(errorMessage(e, "Could not download the report"));
    }
  };

  const s = open?.run.summary;
  return (
    <AppShell>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Migrations</h1>
        <span className="faint" style={{ fontSize: 13 }}>
          Imports of existing HR network folders and SharePoint libraries: inventory, mapping dry run, test and production migration, reconciliation. Runs are started by IT with <code>scripts/migrate.js</code>.
        </span>
      </div>
      {error && <div className="card" style={{ padding: 16, color: "var(--danger)" }}>{error}</div>}
      {!runs ? (
        !error && <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : runs.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>No migrations yet.</div>
      ) : (
        <div className="list">
          {runs.map((r) => (
            <div key={r._id} className={`row clickable${open?.run._id === r._id ? " selected" : ""}`} onClick={() => show(r._id)}>
              <span aria-hidden>{r.source.kind === "sharepoint" ? "☁" : "🗄"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div className="faint" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                  {r.source.label} · {dayjs(r.createdAt).format("MMM D, YYYY")}
                </div>
              </div>
              {r.summary.inventory && <span className="label">{r.summary.inventory.files} files</span>}
              <span className={`badge ${r.status === "reconciled" ? "ready" : r.status === "failed" ? "failed" : "processing"}`}>
                <span className="dot" /> {STEP_LABEL[r.status] || r.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {open && s && (
        <div className="scan-batch-grid" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="card-header">1 · Inventory</div>
            <div style={{ padding: 12, fontSize: 13, display: "grid", gap: 6 }}>
              {s.inventory ? (
                <>
                  <span>
                    <b>{s.inventory.files}</b> files · {mb(s.inventory.bytes)} · <b>{s.inventory.importable}</b> importable · {s.inventory.likelyDuplicates} likely duplicates
                  </span>
                  {Object.entries(s.inventory.issues).map(([k, v]) => (
                    <span key={k} className="faint">
                      {k}: {v}
                    </span>
                  ))}
                  <span className="faint">Age: {Object.entries(s.inventory.byAge).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>
                  <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => download(open.run._id, "inventory")}>
                    ⬇ Inventory CSV
                  </button>
                </>
              ) : (
                <span className="faint">Not run yet.</span>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">2 · Mapping (dry run)</div>
            <div style={{ padding: 12, fontSize: 13, display: "grid", gap: 6 }}>
              {s.mapping ? (
                <>
                  <span>
                    <b>{s.mapping.mapped}</b> mapped · <b style={{ color: s.mapping.unmapped ? "var(--attention)" : undefined }}>{s.mapping.unmapped}</b> unmapped · {s.mapping.withProblems} with problems
                  </span>
                  {open.unmapped.length > 0 && <span className="faint">Unmapped: {open.unmapped.slice(0, 5).join(", ")}{open.unmapped.length > 5 ? "…" : ""}</span>}
                  <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => download(open.run._id, "mapping")}>
                    ⬇ Mapping CSV
                  </button>
                </>
              ) : (
                <span className="faint">Not run yet.</span>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">3 · Migration</div>
            <div style={{ padding: 12, fontSize: 13, display: "grid", gap: 6 }}>
              {(s.migration || []).length ? (
                s.migration!.map((p, i) => (
                  <span key={i}>
                    {p.mode === "test" ? "Test" : "Production"} pass, {dayjs(p.at).format("MMM D h:mm A")}: {p.imported} imported, {p.skipped} skipped, {p.failed} failed
                  </span>
                ))
              ) : (
                <span className="faint">Not run yet.</span>
              )}
              <span className="faint">
                Files now: {Object.entries(open.items).map(([k, v]) => `${v} ${k}`).join(" · ")}
              </span>
              {open.failed.slice(0, 5).map((f) => (
                <span key={f.path} style={{ color: "var(--danger)" }}>
                  {f.path}: {f.reason}
                </span>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-header">4 · Reconciliation</div>
            <div style={{ padding: 12, fontSize: 13, display: "grid", gap: 6 }}>
              {s.reconciliation ? (
                <>
                  <span>
                    {s.reconciliation.source} in source = {s.reconciliation.imported} imported + {s.reconciliation.skipped} skipped + {s.reconciliation.failed} failed + {s.reconciliation.pending} not yet migrated
                  </span>
                  <strong style={{ color: s.reconciliation.accountedFor ? "var(--success)" : "var(--danger)" }}>{s.reconciliation.accountedFor ? "Every file accounted for" : "Counts do not add up"}</strong>
                  <span>
                    Hash check: {s.reconciliation.verified.match} match · {s.reconciliation.verified.mismatch} mismatch · {s.reconciliation.verified.missing} missing
                  </span>
                  {Object.entries(s.reconciliation.skippedBy).map(([k, v]) => (
                    <span key={k} className="faint">
                      Skipped — {k}: {v}
                    </span>
                  ))}
                  <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => download(open.run._id, "reconciliation")}>
                    ⬇ Reconciliation CSV
                  </button>
                </>
              ) : (
                <span className="faint">Not run yet.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
