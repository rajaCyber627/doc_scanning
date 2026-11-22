/** Render a snippet with server-provided highlight ranges — as text, never as HTML. */
export default function Highlighted({ text, ranges }: { text: string; ranges?: [number, number][] }) {
  if (!ranges || !ranges.length) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let pos = 0;
  [...ranges]
    .sort((a, b) => a[0] - b[0])
    .forEach(([a, b], i) => {
      if (a < pos || b > text.length || a >= b) return; // ignore overlaps / bad ranges
      if (a > pos) parts.push(<span key={`t${i}`}>{text.slice(pos, a)}</span>);
      parts.push(<mark key={`m${i}`}>{text.slice(a, b)}</mark>);
      pos = b;
    });
  if (pos < text.length) parts.push(<span key="end">{text.slice(pos)}</span>);
  return <>{parts}</>;
}
