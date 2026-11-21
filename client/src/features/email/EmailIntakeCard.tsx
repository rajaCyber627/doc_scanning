import { useCallback, useEffect, useState } from "react";
import { message } from "antd";
import axios from "axios";
import dayjs from "dayjs";
import { errorMessage } from "../upload/uploadApi";

interface Settings {
  enabled: boolean;
  allowList: string[];
  ownerEmail: string;
  importBody: "auto" | "always" | "never";
  minBodyChars: number;
}
interface Status {
  source: "graph" | "local" | null;
  mailbox: string | null;
  pollSec: number;
  settings: Settings;
  lastRun: { at: string; imported: number; rejected: number; duplicate: number; failed: number; errors: string[] } | null;
}
interface LogRow {
  _id: string;
  from: string;
  messageId: string;
  status: "imported" | "rejected" | "duplicate" | "failed";
  reason: string;
  fileId: string | null;
  attachments: number;
  createdAt: string;
}

/** Admin: the HR intake mailbox — allowed senders, who owns e-mailed documents, what
 *  happens to message bodies, and what came in. */
export default function EmailIntakeCard({ userId }: { userId: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [form, setForm] = useState({ allowList: "", ownerEmail: "", importBody: "auto" as Settings["importBody"], enabled: true });
  const [log, setLog] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    axios
      .get("/api/email-intake", { params: { userId } })
      .then((r) => {
        setSt(r.data);
        const s: Settings = r.data.settings;
        setForm({ allowList: s.allowList.join("\n"), ownerEmail: s.ownerEmail, importBody: s.importBody, enabled: s.enabled });
      })
      .catch(() => setSt(null));
    axios
      .get("/api/email-intake/log", { params: { userId, limit: 20 } })
      .then((r) => setLog(r.data))
      .catch(() => {});
  }, [userId]);
  useEffect(load, [load]);
  if (!st) return null;

  const save = async () => {
    setBusy("save");
    try {
      await axios.put("/api/email-intake", { userId, settings: { ...form, ownerEmail: form.ownerEmail || undefined } });
      message.success("Email intake saved");
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
      const r = (await axios.post("/api/email-intake/poll", { userId })).data;
      if (r.errors?.length && !r.imported && !r.rejected && !r.duplicate) message.warning(r.errors[0]);
      else message.success(`Checked — ${r.imported} imported, ${r.rejected} rejected, ${r.duplicate} already had`);
      load();
    } catch (e) {
      message.error(errorMessage(e, "Could not check the mailbox"));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">Email intake</div>
      <div style={{ padding: 16, display: "grid", gap: 10, fontSize: 13 }}>
        <span className="faint">
          {st.source === "graph"
            ? `Reading the shared mailbox ${st.mailbox} every ${st.pollSec} seconds.`
            : st.source === "local"
            ? `Reading .eml / .msg files from the local folder ${st.mailbox} (test mode) every ${st.pollSec} seconds.`
            : "Not connected to a mailbox on this server (EMAIL_INTAKE_SOURCE). Staff can still drag saved .eml / .msg files onto Documents."}{" "}
          Each attachment becomes a linked document; the message moves to Processed or Rejected.
        </span>
        <label style={{ display: "grid", gap: 4 }}>
          Allowed senders — addresses or domains, one per line (everything else is rejected)
          <textarea rows={4} value={form.allowList} onChange={(e) => setForm({ ...form, allowList: e.target.value })} aria-label="Allowed senders" placeholder={"portsmouthva.gov\npartner@benefits-provider.com"} />
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input aria-label="Owner of e-mailed documents" placeholder="Documents belong to (email)" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} style={{ minWidth: 240 }} />
          <select aria-label="Message body" value={form.importBody} onChange={(e) => setForm({ ...form, importBody: e.target.value as Settings["importBody"] })}>
            <option value="auto">File the message text only when it says something</option>
            <option value="always">Always file the message text</option>
            <option value="never">Only file the attachments</option>
          </select>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> On
          </label>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={save}>
            Save
          </button>
          <button className="btn btn-sm" disabled={!!busy || !st.source} onClick={poll}>
            {busy === "poll" ? "Checking…" : "Check now"}
          </button>
        </div>
        {st.lastRun && (
          <span className="faint">
            Last check {dayjs(st.lastRun.at).format("h:mm A")}: {st.lastRun.imported} imported, {st.lastRun.rejected} rejected, {st.lastRun.duplicate} already had
            {st.lastRun.errors.length > 0 && <span style={{ color: "var(--danger)" }}> · {st.lastRun.errors[0]}</span>}
          </span>
        )}
        {log.length > 0 && (
          <table className="acc-table">
            <tbody>
              {log.map((x) => (
                <tr key={x._id}>
                  <td>{dayjs(x.createdAt).format("MMM D h:mm A")}</td>
                  <td>{x.from || "—"}</td>
                  <td>
                    {x.status === "imported" ? (
                      x.fileId ? <a href={`/files/${x.fileId}`}>Imported{x.attachments ? ` · ${x.attachments} attachment${x.attachments > 1 ? "s" : ""}` : ""}</a> : "Imported"
                    ) : x.status === "duplicate" ? (
                      "Already imported"
                    ) : (
                      <span style={{ color: "var(--danger)" }}>{x.status === "rejected" ? "Rejected" : "Failed"}: {x.reason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
