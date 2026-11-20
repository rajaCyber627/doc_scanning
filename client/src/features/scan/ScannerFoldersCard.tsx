import { useCallback, useEffect, useState } from "react";
import { message } from "antd";
import axios from "axios";
import dayjs from "dayjs";
import { errorMessage } from "../upload/uploadApi";

interface Profile {
  name: string;
  kind: "local" | "s3";
  path?: string;
  prefix?: string;
  ownerEmail?: string;
  batchMode: "none" | "subfolder" | "daily";
  enabled: boolean;
}
interface Status {
  profiles: Profile[];
  root: string | null;
  intervalSec: number;
  enabled: boolean;
  lastRun: { at: string; results: { profile: string; imported: number; rejected: number; waiting: number; errors: string[] }[] } | null;
}
interface ImportRow {
  _id: string;
  profile: string;
  path: string;
  status: "imported" | "rejected";
  reason: string;
  fileId: string | null;
  createdAt: string;
}
const blank = (): Profile => ({ name: "", kind: "local", path: "", ownerEmail: "", batchMode: "subfolder", enabled: true });

/** Admin: network folders / S3 prefixes that office scanners save to (hot folders). */
export default function ScannerFoldersCard({ userId }: { userId: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [rows, setRows] = useState<Profile[]>([]);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    axios
      .get("/api/hotfolders", { params: { userId } })
      .then((r) => {
        setSt(r.data);
        setRows(r.data.profiles);
      })
      .catch(() => setSt(null));
    axios
      .get("/api/hotfolders/imports", { params: { userId, limit: 20 } })
      .then((r) => setImports(r.data))
      .catch(() => {});
  }, [userId]);
  useEffect(load, [load]);
  if (!st) return null;

  const set = (i: number, patch: Partial<Profile>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setBusy("save");
    try {
      await axios.put("/api/hotfolders", { userId, profiles: rows });
      message.success("Scanner folders saved");
      load();
    } catch (e) {
      message.error(errorMessage(e, "Could not save"));
    } finally {
      setBusy("");
    }
  };
  const poll = async () => {
    setBusy("poll");
    try {
      const r = await axios.post("/api/hotfolders/poll", { userId });
      const n = (r.data as any[]).reduce((a, x) => a + x.imported, 0);
      message.success(`Checked — ${n} new file${n === 1 ? "" : "s"} imported`);
      load();
    } catch (e) {
      message.error(errorMessage(e, "Could not check the folders"));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">Scanner folders</div>
      <div style={{ padding: 16, display: "grid", gap: 10, fontSize: 13 }}>
        <span className="faint">
          Office scanners and copiers save to these folders; new files are imported every {st.intervalSec} seconds as scanned documents. No software is needed on any PC.
          {st.root ? ` Local folders are inside ${st.root}.` : " Local folders need HOTFOLDER_ROOT on the server; S3 prefixes work without it."}
          {!st.enabled && " Automatic checking is switched off on this server (HOTFOLDER_ENABLED=false)."}
        </span>
        {rows.map((r, i) => (
          <div key={i} className="inset" style={{ padding: 10, display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input aria-label="Folder name" placeholder="Name, e.g. HR copier" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
              <select aria-label="Folder kind" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as Profile["kind"] })}>
                <option value="local">Network folder</option>
                <option value="s3">S3 prefix</option>
              </select>
              {r.kind === "local" ? (
                <input aria-label="Folder path" placeholder="sub-folder of the share, e.g. hr" value={r.path || ""} onChange={(e) => set(i, { path: e.target.value })} />
              ) : (
                <input aria-label="S3 prefix" placeholder="scanners/hr-copier/" value={r.prefix || ""} onChange={(e) => set(i, { prefix: e.target.value })} />
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input aria-label="Owner email" placeholder="Documents belong to (email)" value={r.ownerEmail || ""} onChange={(e) => set(i, { ownerEmail: e.target.value })} />
              <select aria-label="Batches" value={r.batchMode} onChange={(e) => set(i, { batchMode: e.target.value as Profile["batchMode"] })}>
                <option value="subfolder">One batch per sub-folder (else per day)</option>
                <option value="daily">One batch per day</option>
                <option value="none">No batches</option>
              </select>
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} /> On
              </label>
              <button className="btn btn-sm btn-ghost" aria-label={`Remove ${r.name || "folder"}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
            {st.lastRun?.results
              .filter((x) => x.profile === r.name)
              .map((x) => (
                <span key={x.profile} className="faint">
                  Last check {dayjs(st.lastRun!.at).format("h:mm A")}: {x.imported} imported, {x.rejected} rejected{x.waiting ? `, ${x.waiting} still being written` : ""}
                  {x.errors.length > 0 && <span style={{ color: "var(--danger)" }}> · {x.errors[0]}</span>}
                </span>
              ))}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-sm" onClick={() => setRows((rs) => [...rs, blank()])}>
            ＋ Add folder
          </button>
          <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={save}>
            Save
          </button>
          <button className="btn btn-sm" disabled={!!busy || !st.profiles.length} onClick={poll}>
            {busy === "poll" ? "Checking…" : "Check now"}
          </button>
        </div>
        {imports.length > 0 && (
          <div>
            <strong>Recent files</strong>
            <table className="acc-table">
              <tbody>
                {imports.map((x) => (
                  <tr key={x._id}>
                    <td>{dayjs(x.createdAt).format("MMM D h:mm A")}</td>
                    <td>{x.profile}</td>
                    <td>{x.fileId ? <a href={`/files/${x.fileId}`}>{x.path}</a> : x.path}</td>
                    <td>{x.status === "imported" ? "Imported" : <span style={{ color: "var(--danger)" }}>Rejected: {x.reason}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
