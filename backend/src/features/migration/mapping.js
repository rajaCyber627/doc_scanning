// Mapping rules: folder patterns → person and metadata. A rules file (JSON):
// {
//   "rules": [
//     { "name": "Employee folders",
//       "pattern": "Employees/{LastName}_{FirstName}_{EmployeeID}/{Category}/**",
//       "categories": { "Payroll": "payroll.tax-withholding-forms", "Benefits": "benefits.enrollment-documentation" },
//       "set": { "confidentialityLevel": "Confidential" } }
//   ],
//   "requireMapping": false
// }
// Pattern syntax (case-insensitive, "/" separates folders, "\" is accepted too):
//   {Name}  a named part of one folder or file name (letters, digits, spaces, - . ')
//   *       any single folder / file name      **  any number of folders
// Known names: EmployeeID, ApplicantNumber, LastName, FirstName, FullName, Category,
// DocumentType, Year. The first matching rule wins.
const { getPartner } = require('../../providers/partner');

const KNOWN = new Set(['EmployeeID', 'ApplicantNumber', 'LastName', 'FirstName', 'FullName', 'Category', 'DocumentType', 'Year']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(rule, i) {
  const where = `Rule ${i + 1}${rule.name ? ` (${rule.name})` : ''}`;
  const pattern = String(rule.pattern || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!pattern) throw new Error(`${where}: a pattern is required`);
  const names = [];
  const segs = pattern.split('/').map((seg) => {
    if (seg === '**') return '(?:.*/)?'; // folded with the following "/" below
    if (seg === '*') return '[^/]+/';
    let out = '';
    let last = 0;
    const re = /\{([A-Za-z]+)\}/g;
    let m;
    while ((m = re.exec(seg))) {
      if (!KNOWN.has(m[1])) throw new Error(`${where}: unknown name {${m[1]}} — use ${[...KNOWN].map((k) => `{${k}}`).join(', ')}`);
      out += esc(seg.slice(last, m.index)) + `([^/]+?)`;
      names.push(m[1]);
      last = m.index + m[0].length;
    }
    return `${out}${esc(seg.slice(last))}/`;
  });
  // the pattern describes folders; a trailing ** (or *) matches the file itself
  let src = segs.join('');
  src = src.replace(/\(\?:\.\*\/\)\?$/, '.*/?').replace(/\/$/, '(?:/.*)?');
  const regex = new RegExp(`^${src.replace(/\/\(\?:\.\*\/\)\?/g, '/(?:.*/)?')}$`, 'i');
  return { name: rule.name || `Rule ${i + 1}`, regex, names, categories: rule.categories || {}, set: rule.set || {} };
}

/** Validate a rules file; returns { rules: compiled[], requireMapping }. */
function compileRules(config) {
  if (!config || !Array.isArray(config.rules) || !config.rules.length) throw new Error('The mapping file needs a "rules" list');
  return { rules: config.rules.map(compile), requireMapping: !!config.requireMapping };
}

const clean = (v) => String(v || '').replace(/[_]+/g, ' ').trim();

/**
 * Map one source path. Returns null when no rule matches, else
 * { rule, values, employeeId, personId, personName, documentType, category, problems[] }.
 * `cache` memoises directory lookups across files.
 */
async function mapPath(compiled, relPath, taxonomy, cache = new Map()) {
  const p = relPath.replace(/\\/g, '/');
  for (const r of compiled.rules) {
    const m = r.regex.exec(p);
    if (!m) continue;
    const values = {};
    r.names.forEach((n, i) => {
      values[n] = clean(m[i + 1]);
    });
    const out = { rule: r.name, values, problems: [], ...r.set };
    // document type: explicit, or via the category map
    let typeKey = values.DocumentType || '';
    if (values.Category) {
      const mapped = Object.entries(r.categories).find(([k]) => k.toLowerCase() === values.Category.toLowerCase());
      if (mapped) typeKey = mapped[1];
      else if (!typeKey) out.problems.push(`Folder "${values.Category}" has no document type in the rule's categories`);
    }
    if (typeKey) {
      const t = taxonomy.documentTypes.find((x) => x.key === typeKey || x.name.toLowerCase() === typeKey.toLowerCase());
      if (t) out.documentType = t.key;
      else out.problems.push(`Unknown document type "${typeKey}"`);
    }
    if (values.Year && /^(19|20)\d{2}$/.test(values.Year)) out.year = Number(values.Year);
    // person: employee / applicant number checked against the HR directory
    const id = values.EmployeeID || values.ApplicantNumber;
    if (id) {
      out.employeeId = values.EmployeeID || undefined;
      out.applicantNumber = values.ApplicantNumber || undefined;
      const k = `id:${id}`;
      if (!cache.has(k)) {
        const field = values.EmployeeID ? 'employeeId' : 'applicantNumber';
        const hits = (await getPartner().lookupPerson(id)).filter((x) => String(x[field] || '').toLowerCase() === id.toLowerCase());
        cache.set(k, hits.length === 1 ? hits[0] : null);
      }
      const person = cache.get(k);
      if (person) {
        out.personId = person.personId;
        out.personName = person.name;
        const name = values.FullName || [values.FirstName, values.LastName].filter(Boolean).join(' ');
        const tokens = (s) => s.toLowerCase().split(/[\s,.'-]+/).filter((t) => t.length > 1);
        if (name && !tokens(name).every((t) => tokens(person.name).includes(t))) out.problems.push(`Folder name "${name}" differs from the directory ("${person.name}") for ID ${id}`);
      } else out.problems.push(`ID ${id} is not in the HR directory`);
    } else if (values.FullName || values.LastName) {
      out.personName = values.FullName || [values.FirstName, values.LastName].filter(Boolean).join(' ');
      out.problems.push('No employee ID in the path — the person is matched by name only at review');
    }
    return out;
  }
  return null;
}

module.exports = { compileRules, mapPath, KNOWN };
