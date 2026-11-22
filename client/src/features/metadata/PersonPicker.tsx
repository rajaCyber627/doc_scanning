import { useEffect, useId, useRef, useState } from "react";
import { lookupPeople, Person } from "./metadataApi";

/** Search the HR directory by name or ID; picking a person fills their details. */
export default function PersonPicker({
  id,
  value,
  onPick,
  invalid,
}: {
  id?: string;
  value: { employeeName?: string; employeeId?: string; applicantNumber?: string };
  onPick: (p: Person) => void;
  invalid?: boolean;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      lookupPeople(q.trim())
        .then((r) => {
          setResults(r);
          setActive(0);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  const choose = (p: Person) => {
    onPick(p);
    setQ("");
    setOpen(false);
  };

  const current = value.employeeName
    ? `${value.employeeName}${value.employeeId ? ` · ID ${value.employeeId}` : value.applicantNumber ? ` · ${value.applicantNumber}` : ""}`
    : "";

  return (
    <div className="person-picker">
      {current && <div className="person-current">{current}</div>}
      <input
        id={id}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        placeholder={current ? "Change person — name or ID" : "Search name or employee / applicant ID"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !results.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(results[active]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul id={listId} role="listbox" className="person-results">
          {results.map((p, i) => (
            <li
              key={p.personId}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
            >
              <strong>{p.name}</strong> · {p.employeeId ? `ID ${p.employeeId}` : p.applicantNumber} · {p.type}
              <div className="faint">
                {p.positionTitle} — {p.department}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
