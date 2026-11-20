/** Scan settings guidance (RFP: scanning) — for the camera and for office scanners. */
export default function ScanTips() {
  return (
    <aside className="card" aria-label="Scanning tips">
      <div className="card-header">Getting a good scan</div>
      <div style={{ padding: 12, fontSize: 13, display: "grid", gap: 10 }}>
        <div>
          <strong>With the camera</strong>
          <ul className="tight">
            <li>Lay the page flat on a darker surface, in even light.</li>
            <li>Hold the phone straight above the page; fill most of the screen.</li>
            <li>Avoid your shadow and the flash glare; one page per photo.</li>
          </ul>
        </div>
        <div>
          <strong>On an office scanner or copier</strong>
          <ul className="tight">
            <li>
              <b>300 dpi</b>, file type <b>PDF</b> (one file per document or per stack).
            </li>
            <li>
              <b>Black-and-white</b> for typed or printed text; <b>color</b> only for photos, colored stamps or highlights (much larger files).
            </li>
            <li>
              <b>Duplex</b> (both sides) when pages are printed on the back; blank backs are flagged for removal.
            </li>
            <li>Remove staples and sticky notes; straighten folded corners.</li>
            <li>
              Save to the <b>HR scanner folder</b> (ask your administrator for its name) — files appear here within a minute. Put a separator sheet between documents to have a stack split automatically.
            </li>
          </ul>
        </div>
      </div>
    </aside>
  );
}
