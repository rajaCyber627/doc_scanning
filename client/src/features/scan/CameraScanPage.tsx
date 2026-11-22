import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { message } from "antd";
import { PDFDocument } from "pdf-lib";
import AppShell from "../../components/AppShell";
import { getUser } from "../../auth";
import { uploadFile } from "../upload/uploader";
import { errorMessage } from "../upload/uploadApi";
import { deviceLabel, detectQuad, documentFilter, FilterMode, Img, outputSize, Quad, warp } from "./scanMath";
import ScanTips from "./ScanTips";

interface ScanPage {
  id: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}
interface Shot {
  img: Img; // full-resolution capture
  quad: Quad; // page corners in capture pixels
  found: boolean;
}

const DETECT_W = 320; // detection runs on a small copy (fast, enough for corners)
const uid = () => Math.random().toString(36).slice(2, 10);

function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function imgFromSource(src: CanvasImageSource, w: number, h: number, maxSide = 3000): Img {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = canvasOf(Math.round(w * s), Math.round(h * s));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: c.width, height: c.height };
}
function smallCopy(img: Img): { small: Img; scale: number } {
  const scale = Math.min(1, DETECT_W / img.width);
  if (scale === 1) return { small: img, scale };
  const big = canvasOf(img.width, img.height);
  big.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return { small: imgFromSource(big, img.width, img.height, Math.round(Math.max(img.width, img.height) * scale)), scale };
}
const fullQuad = (img: Img): Quad => [
  { x: 0, y: 0 },
  { x: img.width - 1, y: 0 },
  { x: img.width - 1, y: img.height - 1 },
  { x: 0, y: img.height - 1 },
];
function findPage(img: Img): Shot {
  const { small, scale } = smallCopy(img);
  const q = detectQuad(small);
  return q ? { img, quad: q.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad, found: true } : { img, quad: fullQuad(img), found: false };
}
function toJpeg(img: Img): Promise<Blob> {
  const c = canvasOf(img.width, img.height);
  c.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not save the page"))), "image/jpeg", 0.85));
}

/** Scan paper with the phone / tablet / laptop camera: edge detection, perspective
 *  correction, document filter, several pages → one PDF (source = camera). */
export default function CameraScanPage() {
  const user = getUser()!;
  const nav = useNavigate();
  const [params] = useSearchParams();
  const batchId = params.get("batch") || undefined;
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const adjustRef = useRef<HTMLCanvasElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<"starting" | "on" | "denied" | "unsupported">("starting");
  const [mode, setMode] = useState<"camera" | "adjust" | "review">("camera");
  const [shot, setShot] = useState<Shot | null>(null);
  const [queue, setQueue] = useState<File[]>([]); // picked photos waiting to be adjusted
  const [filter, setFilter] = useState<FilterMode>("document");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [retakeAt, setRetakeAt] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const dragging = useRef<number | null>(null);

  // ---------------------------------------------------------- camera
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return setCamera("unsupported");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCamera("on");
    } catch {
      setCamera("denied");
    }
  }, []);
  useEffect(() => {
    if (mode === "camera") startCamera();
    else stopCamera();
    return stopCamera;
  }, [mode, startCamera, stopCamera]);

  // live page outline over the video (a few times per second)
  useEffect(() => {
    if (mode !== "camera" || camera !== "on") return;
    const t = setInterval(() => {
      const v = videoRef.current;
      const o = overlayRef.current;
      if (!v || !o || !v.videoWidth) return;
      const small = imgFromSource(v, v.videoWidth, v.videoHeight, DETECT_W);
      const q = detectQuad(small);
      o.width = small.width;
      o.height = small.height;
      const ctx = o.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, o.width, o.height);
      if (!q) return;
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 3;
      ctx.fillStyle = "rgba(34,197,94,0.15)";
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }, 350);
    return () => clearInterval(t);
  }, [mode, camera]);

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setShot(findPage(imgFromSource(v, v.videoWidth, v.videoHeight)));
    setMode("adjust");
  };

  // picked photos (camera denied, or a phone's own camera app)
  const loadPicked = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const im = new Image();
      await new Promise((res, rej) => {
        im.onload = res;
        im.onerror = () => rej(new Error(`"${file.name}" is not an image this browser can open`));
        im.src = url;
      });
      setShot(findPage(imgFromSource(im, im.naturalWidth, im.naturalHeight)));
      setMode("adjust");
    } catch (e) {
      message.error(errorMessage(e, "Could not open the photo"));
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);
  useEffect(() => {
    if (mode !== "adjust" && queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest);
      loadPicked(next);
    }
  }, [queue, mode, loadPicked]);

  // ---------------------------------------------------------- adjust corners
  const view = useRef({ scale: 1 });
  const drawAdjust = useCallback(() => {
    const c = adjustRef.current;
    if (!c || !shot) return;
    const maxW = Math.min(window.innerWidth - 48, 720);
    const scale = Math.min(1, maxW / shot.img.width, (window.innerHeight * 0.6) / shot.img.height);
    view.current.scale = scale;
    c.width = Math.round(shot.img.width * scale);
    c.height = Math.round(shot.img.height * scale);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const full = canvasOf(shot.img.width, shot.img.height);
    full.getContext("2d")!.putImageData(new ImageData(shot.img.data, shot.img.width, shot.img.height), 0, 0);
    ctx.drawImage(full, 0, 0, c.width, c.height);
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 3;
    ctx.beginPath();
    shot.quad.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#22c55e";
    shot.quad.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, 12, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [shot]);
  useEffect(drawAdjust, [drawAdjust]);

  const pointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const s = view.current.scale;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!shot) return;
    const p = pointer(e);
    const tol = 30 / view.current.scale;
    const i = shot.quad.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol);
    if (i >= 0) {
      dragging.current = i;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragging.current === null || !shot) return;
    const p = pointer(e);
    const q = shot.quad.slice() as Quad;
    q[dragging.current] = { x: Math.max(0, Math.min(shot.img.width - 1, p.x)), y: Math.max(0, Math.min(shot.img.height - 1, p.y)) };
    setShot({ ...shot, quad: q });
  };
  const onUp = () => {
    dragging.current = null;
  };

  const keepPage = async () => {
    if (!shot) return;
    setBusy("page");
    try {
      const size = outputSize(shot.quad);
      const flat = documentFilter(warp(shot.img, shot.quad, size.width, size.height), filter);
      const blob = await toJpeg(flat);
      const page: ScanPage = { id: uid(), blob, url: URL.createObjectURL(blob), width: flat.width, height: flat.height };
      setPages((ps) => {
        if (retakeAt !== null && ps[retakeAt]) {
          URL.revokeObjectURL(ps[retakeAt].url);
          return ps.map((p, i) => (i === retakeAt ? page : p));
        }
        return [...ps, page];
      });
      setRetakeAt(null);
      setShot(null);
      // next: more picked photos (via review), back to a retake's list, or the next camera shot
      setMode(retakeAt !== null || queue.length || camera !== "on" ? "review" : "camera");
    } catch (e) {
      message.error(errorMessage(e, "Could not process the page"));
    } finally {
      setBusy("");
    }
  };

  // ---------------------------------------------------------- review + save
  const movePage = (i: number, d: number) =>
    setPages((ps) => {
      const j = i + d;
      if (j < 0 || j >= ps.length) return ps;
      const next = ps.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removePage = (i: number) =>
    setPages((ps) => {
      URL.revokeObjectURL(ps[i].url);
      return ps.filter((_, j) => j !== i);
    });
  useEffect(() => () => pages.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!pages.length) return;
    setBusy("save");
    try {
      const pdf = await PDFDocument.create();
      pdf.setTitle(name || "Scanned document");
      pdf.setCreator("DocP camera scan");
      for (const p of pages) {
        const img = await pdf.embedJpg(new Uint8Array(await p.blob.arrayBuffer()));
        // US Letter width; height follows the page's shape
        const w = 612;
        const h = (p.height / p.width) * w;
        pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      }
      const bytes = await pdf.save();
      const fname = `${(name.trim() || `Camera scan ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
      const file = new File([bytes], fname, { type: "application/pdf" });
      const doc = await uploadFile(file, { userId: user._id, batchId, hints: { source: "camera", device: deviceLabel(navigator.userAgent), pages: String(pages.length) } });
      message.success(`Saved "${fname}" — it is being read now`);
      if (batchId) {
        // keep scanning into the same batch
        pages.forEach((p) => URL.revokeObjectURL(p.url));
        setPages([]);
        setName("");
        setMode("camera");
      } else nav(`/files/${doc._id}`);
    } catch (e) {
      message.error(errorMessage(e, "Could not save the scan"));
    } finally {
      setBusy("");
    }
  };

  const picker = (
    <input
      ref={pickRef}
      type="file"
      accept="image/*"
      capture="environment"
      multiple
      hidden
      aria-label="Take or choose photos"
      onChange={(e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (files.length) setQueue((q) => [...q, ...files]);
      }}
    />
  );

  return (
    <AppShell>
      {picker}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ margin: 0 }}>Scan with camera</h1>
          <span className="faint" style={{ fontSize: 13 }}>
            Photograph each page — it is cropped, straightened and cleaned up, then saved as one PDF.
          </span>
          {batchId && (
            <div style={{ fontSize: 13, marginTop: 4 }}>
              Adding to a scan batch · <a href={`/batches/${batchId}`} onClick={(e) => { e.preventDefault(); nav(`/batches/${batchId}`); }}>back to the batch</a>
            </div>
          )}
        </div>
        {pages.length > 0 && mode !== "review" && (
          <button className="btn btn-sm" onClick={() => setMode("review")}>
            Done · {pages.length} page{pages.length > 1 ? "s" : ""}
          </button>
        )}
      </div>

      <div className="scan-layout">
        <div className="card" style={{ padding: 12, minWidth: 0 }}>
          {mode === "camera" && (
            <>
              {camera === "on" || camera === "starting" ? (
                <div className="scan-video-wrap">
                  <video ref={videoRef} playsInline muted className="scan-video" aria-label="Camera preview" />
                  <canvas ref={overlayRef} className="scan-overlay" aria-hidden="true" />
                </div>
              ) : (
                <div className="inset" style={{ padding: 16, display: "grid", gap: 8 }} role="status">
                  <strong>{camera === "denied" ? "Camera access was not allowed." : "This browser cannot use the camera here."}</strong>
                  <span className="faint">
                    {camera === "denied" ? "Allow camera access in the browser settings, or take the photos with the phone's camera app and choose them below." : "Take the photos with the device's camera app and choose them below. (Camera access needs HTTPS.)"}
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", justifyContent: "center" }}>
                {camera === "on" && (
                  <button className="btn btn-primary scan-shutter" onClick={capture}>
                    ● Capture page {retakeAt !== null ? `${retakeAt + 1} again` : pages.length + 1}
                  </button>
                )}
                <button className="btn" onClick={() => pickRef.current?.click()}>
                  {camera === "on" ? "Choose photos instead" : "Take / choose photos"}
                </button>
              </div>
            </>
          )}

          {mode === "adjust" && shot && (
            <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
              <span className="faint" role="status">
                {shot.found ? "Page found — drag the green corners if they are off." : "No clear page edge found — drag the green corners onto the page corners."}
              </span>
              <canvas ref={adjustRef} className="scan-adjust" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label="Captured page with adjustable corners" />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", alignItems: "center" }}>
                <label>
                  Look{" "}
                  <select value={filter} onChange={(e) => setFilter(e.target.value as FilterMode)} aria-label="Page look">
                    <option value="document">Document (black and white)</option>
                    <option value="gray">Grayscale</option>
                    <option value="color">Color (photos, stamps, highlights)</option>
                  </select>
                </label>
                <button className="btn btn-sm btn-ghost" onClick={() => setShot({ ...shot, quad: fullQuad(shot.img) })}>
                  Use whole photo
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setShot(null);
                    setMode("camera");
                  }}
                >
                  Retake
                </button>
                <button className="btn btn-sm btn-primary" disabled={busy === "page"} onClick={keepPage}>
                  {busy === "page" ? "Straightening…" : "Keep page"}
                </button>
              </div>
            </div>
          )}

          {mode === "review" && (
            <div style={{ display: "grid", gap: 12 }}>
              {pages.length === 0 ? (
                <div className="faint">No pages yet.</div>
              ) : (
                <div className="scan-pages" role="list" aria-label="Scanned pages">
                  {pages.map((p, i) => (
                    <figure key={p.id} className="split-thumb" role="listitem" style={{ width: 130 }}>
                      <img src={p.url} alt={`Page ${i + 1}`} style={{ width: "100%", display: "block" }} />
                      <figcaption>
                        <span>{i + 1}</span>
                        <span style={{ marginLeft: "auto", display: "inline-flex" }}>
                          <button className="btn btn-sm btn-ghost" aria-label={`Move page ${i + 1} earlier`} disabled={i === 0} onClick={() => movePage(i, -1)}>
                            ←
                          </button>
                          <button className="btn btn-sm btn-ghost" aria-label={`Move page ${i + 1} later`} disabled={i === pages.length - 1} onClick={() => movePage(i, 1)}>
                            →
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            aria-label={`Retake page ${i + 1}`}
                            onClick={() => {
                              setRetakeAt(i);
                              setMode("camera");
                            }}
                          >
                            ↺
                          </button>
                          <button className="btn btn-sm btn-ghost" aria-label={`Delete page ${i + 1}`} onClick={() => removePage(i)}>
                            🗑
                          </button>
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn" onClick={() => setMode("camera")}>
                  ＋ Add pages
                </button>
                <input aria-label="Document name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
                <button className="btn btn-primary" disabled={!pages.length || busy === "save"} onClick={save}>
                  {busy === "save" ? "Saving…" : `Save ${pages.length} page${pages.length !== 1 ? "s" : ""} as PDF`}
                </button>
              </div>
            </div>
          )}
        </div>
        <ScanTips />
      </div>
    </AppShell>
  );
}
