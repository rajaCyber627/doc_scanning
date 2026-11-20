// One drag-and-drop experience for every page that accepts files:
//  • drop anywhere on the page (a visual overlay shows where files will go)
//  • nested targets (e.g. a folder row) via useDropTarget() take precedence
//  • whole folders can be dropped (relative paths kept)
//  • unsupported files are rejected up front with the reason, never uploaded
//  • visible, keyboard-reachable "Browse" buttons (openFiles / openFolder)
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState, DragEvent } from "react";
import { fromEvent } from "file-selector";
import { getUploadConfig, UploadConfig } from "./uploadApi";
import { validateFile } from "./uploader";

export interface DropTargetInfo {
  folderId?: string;
  label?: string;
}

interface Rejection {
  name: string;
  reason: string;
}

interface DropZoneApi {
  submit: (files: File[], target?: DropTargetInfo) => void;
  openFiles: (target?: DropTargetInfo) => void;
  openFolder: (target?: DropTargetInfo) => void;
  /** Hide the page overlay (nested targets stop the drop reaching the window). */
  endDrag: () => void;
  config: UploadConfig | null;
}

const Ctx = createContext<DropZoneApi | null>(null);

/** Access the surrounding DropZone (browse buttons, nested drop targets). */
export function useDropZone(): DropZoneApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useDropZone must be used inside <DropZone>");
  return api;
}

const hasFiles = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

async function filesFrom(e: Event | DragEvent): Promise<File[]> {
  const items = (await fromEvent(e as Event)) as (File | DataTransferItem)[];
  return items.filter((f): f is File => f instanceof File);
}

/** Props for a nested drop target such as a folder row. */
export function useDropTarget(target: DropTargetInfo) {
  const { submit, endDrag } = useDropZone();
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  return {
    active,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current++;
        setActive(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setActive(false);
      },
      onDrop: async (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setActive(false);
        endDrag();
        const pending = filesFrom(e); // read the drop synchronously, resolve later
        submit(await pending, target);
      },
    },
  };
}

interface DropZoneProps {
  /** Receives only valid files, plus the target they were dropped on. */
  onFiles: (files: File[], target: DropTargetInfo) => void;
  /** Where a page-level drop goes, e.g. { label: "your documents" }. */
  defaultTarget?: DropTargetInfo;
  children: ReactNode;
}

export default function DropZone({ onFiles, defaultTarget = {}, children }: DropZoneProps) {
  const [config, setConfig] = useState<UploadConfig | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const endDrag = useCallback(() => {
    dragDepth.current = 0;
    setDragging(false);
  }, []);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<DropTargetInfo | undefined>(undefined);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const defaultRef = useRef(defaultTarget);
  defaultRef.current = defaultTarget;

  useEffect(() => {
    getUploadConfig().then(setConfig).catch(() => {});
    dirInput.current?.setAttribute("webkitdirectory", "");
    dirInput.current?.setAttribute("directory", "");
  }, []);

  const configRef = useRef<UploadConfig | null>(null);
  configRef.current = config;

  // Validates against the server's rules; if they haven't loaded yet, waits for them
  // (so even a drop in the first moment after page load is checked).
  const submit = useCallback(
    async (files: File[], target?: DropTargetInfo) => {
      if (!files.length) return;
      const cfg = configRef.current || (await getUploadConfig().catch(() => null));
      // Skip OS clutter that comes along with folder drops.
      const real = files.filter((f) => !/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(f.name) && !f.name.startsWith("~$"));
      const ok: File[] = [];
      const bad: Rejection[] = [];
      for (const f of real) {
        const reason = cfg ? validateFile(f, cfg) : null;
        if (reason) bad.push({ name: f.name, reason });
        else ok.push(f);
      }
      setRejected(bad);
      if (ok.length) onFilesRef.current(ok, target || defaultRef.current);
    },
    []
  );

  // Clear the rejection notice after a while.
  useEffect(() => {
    if (!rejected.length) return;
    const t = setTimeout(() => setRejected([]), 12000);
    return () => clearTimeout(t);
  }, [rejected]);

  // Window-level drag handling: show the overlay, and route drops that no nested
  // target handled to the page's default target (instead of the browser opening the file).
  useEffect(() => {
    const enter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const leave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const over = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow dropping anywhere
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    // Only drops that no nested target handled reach the window (targets stop propagation).
    const drop = async (e: globalThis.DragEvent) => {
      endDrag();
      if (!hasFiles(e)) return;
      e.preventDefault(); // never let the browser navigate to the dropped file
      const pending = filesFrom(e);
      submit(await pending);
    };
    const cancel = () => endDrag();
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", cancel);
    return () => {
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [submit, endDrag]);

  const openFiles = useCallback((target?: DropTargetInfo) => {
    pickTarget.current = target;
    fileInput.current?.click();
  }, []);
  const openFolder = useCallback((target?: DropTargetInfo) => {
    pickTarget.current = target;
    dirInput.current?.click();
  }, []);
  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    submit(files, pickTarget.current);
    pickTarget.current = undefined;
  };

  const label = defaultTarget.label || "this page";
  return (
    <Ctx.Provider value={{ submit, openFiles, openFolder, endDrag, config }}>
      <div>
        <input ref={fileInput} type="file" multiple hidden accept={config?.accept} onChange={onPicked} data-testid="dropzone-file-input" />
        <input ref={dirInput} type="file" multiple hidden onChange={onPicked} />
        {rejected.length > 0 && (
          <div className="drop-rejected card" role="alert">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ flex: 1 }}>
                {rejected.length} file{rejected.length > 1 ? "s" : ""} can't be uploaded
              </strong>
              <button className="btn btn-sm btn-ghost" onClick={() => setRejected([])} aria-label="Dismiss">
                ✕
              </button>
            </div>
            <ul>
              {rejected.slice(0, 8).map((r, i) => (
                <li key={i}>{r.reason}</li>
              ))}
              {rejected.length > 8 && <li>…and {rejected.length - 8} more</li>}
            </ul>
          </div>
        )}
        {children}
      </div>
      <div className={`drop-overlay${dragging ? " show" : ""}`} aria-hidden={!dragging}>
        <div className="drop-overlay-msg" role="status" aria-live="polite">
          {dragging ? `Drop files or a folder to upload to ${label}` : ""}
          {dragging && <span>Drop on a set to add them to that set</span>}
        </div>
      </div>
    </Ctx.Provider>
  );
}

/** Visible, keyboard-accessible browse buttons + the accepted types/limit. */
export function BrowseButtons({ target, compact }: { target?: DropTargetInfo; compact?: boolean }) {
  const { openFiles, openFolder, config } = useDropZone();
  const types = config ? config.acceptedTypes.map((t) => t.ext.toUpperCase()).filter((v, i, a) => a.indexOf(v) === i) : [];
  return (
    <div className="browse-buttons">
      <button className="btn btn-primary" onClick={() => openFiles(target)}>
        ＋ Upload files
      </button>
      <button className="btn" onClick={() => openFolder(target)}>
        ＋ Upload folder
      </button>
      {!compact && config && (
        <span className="faint" style={{ fontSize: 12 }}>
          or drag them here · {types.join(", ")} · up to {Math.round(config.maxBytes / 1048576)} MB each
        </span>
      )}
    </div>
  );
}
