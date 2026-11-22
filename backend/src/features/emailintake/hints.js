// Hints from an email's subject / body for classification (P10). They are passed to the
// AI as unverified context — never written into the record as facts. The one exception is
// protective: a restricted keyword (FMLA, medical…) routes the document to the restricted
// queue straight away, which can only make it safer.
const RESTRICTED = /\b(fmla|family medical leave|medical|doctor'?s? note|diagnos\w*|ada accommodation|accommodation request|workers'? comp\w*|injury report|investigation|grievance|disciplinary)\b/i;
const TYPE_WORDS = [
  [/\bw-?4\b/i, 'W-4'],
  [/\bi-?9\b/i, 'I-9'],
  [/\boffer letter\b/i, 'offer letter'],
  [/\bresignation\b/i, 'resignation'],
  [/\bdirect deposit\b/i, 'direct deposit'],
  [/\bbenefit(s)? (election|enrollment)\b/i, 'benefit election'],
  [/\bperformance (review|evaluation)\b/i, 'performance evaluation'],
  [/\bapplication\b/i, 'application'],
  [/\bfmla\b/i, 'FMLA'],
];

function extractHints(subject = '', body = '') {
  const text = `${subject}\n${String(body).slice(0, 4000)}`;
  const ids = new Set();
  const re = /\b(?:emp(?:loyee)?\.?\s*(?:id|#|no\.?|number)?|id)\s*[:#]?\s*([A-Z]?\d{3,8})\b/gi;
  let m;
  while ((m = re.exec(text)) && ids.size < 5) ids.add(m[1]);
  const keywords = TYPE_WORDS.filter(([r]) => r.test(text)).map(([, k]) => k);
  return {
    subject: String(subject || '').slice(0, 200),
    employeeIds: [...ids],
    keywords,
    restricted: RESTRICTED.test(text),
  };
}

/** The hint block for the classifier prompt (or '' when there is nothing useful). */
function hintText(h) {
  if (!h || (!h.subject && !(h.employeeIds || []).length && !(h.keywords || []).length)) return '';
  const lines = [];
  if (h.subject) lines.push(`Email subject: ${h.subject}`);
  if ((h.employeeIds || []).length) lines.push(`Employee ID(s) mentioned in the email: ${h.employeeIds.join(', ')}`);
  if ((h.keywords || []).length) lines.push(`Words in the email: ${h.keywords.join(', ')}`);
  return `<email_hints>\n${lines.join('\n')}\nThese come from the email the document was sent with and may be wrong or about a different attachment. Use them only where the document itself agrees.\n</email_hints>\n\n`;
}

module.exports = { extractHints, hintText, RESTRICTED };
