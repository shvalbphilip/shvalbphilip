/** Redacts identifiers and secrets before anything is stored in the event stream, logs or reports. */
const RULES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[מפתח-מוסתר]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[טוקן-מוסתר]'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, '[טוקן-מוסתר]'],
  [/\bIL\d{2}(?:[ -]?\d){19}\b/gi, '[IBAN-מוסתר]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[אימייל-מוסתר]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[כרטיס-מוסתר]'],
  [/(?<!\d)0(?:5\d|[2-4]|[7-9])[- ]?\d{3}[- ]?\d{4}(?!\d)/g, '[טלפון-מוסתר]'],
  [/(?<![\d.,])\d{9}(?![\d.,])/g, '[מזהה-מוסתר]'],
  [/(?<![\d.,])\d{6,8}(?![\d.,%])/g, '[מספר-מוסתר]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

export function redactUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

export function clip(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}
