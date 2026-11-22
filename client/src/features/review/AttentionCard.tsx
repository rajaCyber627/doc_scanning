import { useState } from "react";
import { Link } from "react-router-dom";
import { message } from "antd";
import axios from "axios";
import { FileItem } from "../../api";
import { errorMessage } from "../upload/uploadApi";

type Reason = { code: string; message: string; stage?: string; page?: number };
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/**
 * Top of the file page: in plain words, what (if anything) a person still has to do with
 * this document, each with the button that does it. Page notes (blank / sideways pages)
 * are shown too, but they never block filing.
 */
export default function AttentionCard({ file, userId, onChanged }: { file: FileItem; userId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const reasons: Reason[] = file.reviewReasons || [];
  const notes: Reason[] = file.notes || [];
  const by = (stage: string) => reasons.filter((r) => r.stage === stage);
  const canOpenPages = ["ready", "needs_review"].includes(file.status) && (/pdf/i.test(file.mimeType || "") || !!file.renditionS3Key);

  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await fn();
      message.success(done);
      onChanged();
    } catch (e) {
      message.error(errorMessage(e, "That did not work"));
    } finally {
      setBusy("");
    }
  };

  if (file.status === "processing")
    return (
      <div className="attention info" role="status">
        <strong>Reading this document…</strong> Text, pages and suggested details appear here in a moment.
      </div>
    );
  if (file.status === "failed")
    return (
      <div className="attention danger" role="alert">
        <strong>This document could not be processed.</strong> {file.error}
      </div>
    );

  const items: { key: string; title: string; detail?: string; actions: JSX.Element[] }[] = [];
  const split = by("splitting");
  if (split.length)
    items.push({
      key: "split",
      title: "This file looks like several documents",
      detail: split[0].message,
      actions: [
        <Link key="cuts" className="btn btn-sm btn-primary" to={`/files/${file._id}/pages`}>
          Check the suggested cuts
        </Link>,
        <button key="keep" className="btn btn-sm" disabled={!!busy} onClick={() => run("keep", () => axios.post(`/api/files/${file._id}/split/keep`, { userId }), "Kept as one document")}>
          Keep as one document
        </button>,
      ],
    });
  const dup = by("duplicates");
  if (dup.length)
    items.push({
      key: "dup",
      title: "Possible duplicate",
      detail: dup[0].message,
      actions: [
        <button key="d" className="btn btn-sm btn-primary" onClick={() => scrollTo("duplicate-panel")}>
          Compare and decide
        </button>,
      ],
    });
  const cls = by("classification");
  if (cls.length) {
    const unknownType = !file.classification?.suggestion?.documentType;
    items.push({
      key: "cls",
      title: unknownType ? "Choose what kind of document this is" : "Confirm the suggested details",
      detail: unknownType
        ? "The AI could not match it to a document type. Pick one — for documents that are not about one employee (RFPs, policies, letters, reference material) use a “General & reference documents” type."
        : cls[0].message,
      actions: [
        <button key="c" className="btn btn-sm btn-primary" onClick={() => scrollTo("classification-panel")}>
          {unknownType ? "Choose the type" : "Review the details"}
        </button>,
      ],
    });
  }
  const ocr = by("ocr");
  if (ocr.length)
    items.push({
      key: "ocr",
      title: "Check the scan quality",
      detail: ocr.map((r) => r.message).join(" · "),
      actions: [
        ...(canOpenPages
          ? [
              <Link key="p" className="btn btn-sm" to={`/files/${file._id}/pages`}>
                Open the pages
              </Link>,
            ]
          : []),
        ...(!cls.length && !dup.length && !split.length
          ? [
              <button key="ok" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => run("ok", () => axios.post(`/api/files/${file._id}/review`, { userId }), "Marked as checked")}>
                It looks fine
              </button>,
            ]
          : []),
      ],
    });
  const qc = by("qc");
  if (qc.length) items.push({ key: "qc", title: "Failed the quality check — rescan the paper", detail: qc[0].message, actions: [] });
  const known = new Set(["splitting", "duplicates", "classification", "ocr", "qc"]);
  for (const r of reasons.filter((x) => !known.has(x.stage || ""))) items.push({ key: r.code + (r.page || ""), title: r.message, actions: [] });

  const blank = notes.filter((n) => n.code === "BLANK_PAGE").map((n) => n.page);
  const other = notes.filter((n) => n.code !== "BLANK_PAGE").map((n) => n.message);
  const noteText = [blank.length ? `blank page${blank.length > 1 ? "s" : ""} ${blank.join(", ")}` : "", ...other].filter(Boolean).join(" · ");

  return (
    <div className={`attention ${items.length ? "todo" : "done"}`} role="region" aria-label="What needs your attention">
      {items.length === 0 ? (
        <div>
          <strong>✓ Nothing to do.</strong> {file.metadataStatus === "complete" ? "The details are complete and the document is filed." : "This document is ready."}
        </div>
      ) : (
        <>
          <strong>{items.length === 1 ? "1 thing" : `${items.length} things`} to do before this document is filed</strong>
          <ol className="attention-list">
            {items.map((it) => (
              <li key={it.key}>
                <div className="attention-title">{it.title}</div>
                {it.detail && <div className="faint attention-detail">{it.detail}</div>}
                {it.actions.length > 0 && <div className="attention-actions">{it.actions}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
      {notes.length > 0 && (
        <div className="attention-notes">
          <span className="faint">Note: {noteText}. The text was read — remove or turn these pages in the page view if you want.</span>
          {canOpenPages && (
            <Link className="btn btn-sm btn-ghost" to={`/files/${file._id}/pages`}>
              Open the pages
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
