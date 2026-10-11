import { createHash } from 'node:crypto';
import type { ImportResult, MoneyFlag, MoneyView, Transaction } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import { jerusalemDay } from './guard.ts';
import { newId, nowIso } from './util.ts';

/* ---------- parsing ---------- */

/** The header line decides the delimiter: whichever of , ; or tab occurs most outside quotes (comma on a tie or none). */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let q = false;
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''; // leading blank lines don't decide
  for (const c of firstLine) {
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) break;
    else if (!q && (c === ',' || c === ';' || c === '\t')) counts[c]++;
  }
  return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  const src = text.replace(/^﻿/, '');
  const delim = detectDelimiter(src);
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"' && cur === '') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** Decimal-string -> integer agorot without floating point. Returns null if unparseable. */
export function parseAmountAgorot(raw: string): number | null {
  let s = raw.trim().replace(/[₪\s]|NIS|ILS|ש"ח/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  // Strict formats only; anything ambiguous (e.g. "12.345" = 12.345 or 12,345?) is rejected rather than guessed.
  let intPart: string, frac = '', m: RegExpExecArray | null;
  if ((m = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(s))) { intPart = m[1]!.replace(/,/g, ''); frac = m[2] ?? ''; }
  else if ((m = /^(\d+|\d{1,3}(?:\.\d{3})+),(\d{1,2})$/.exec(s))) { intPart = m[1]!.replace(/\./g, ''); frac = m[2]!; }
  else if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(s)) intPart = s.replace(/\./g, '');
  else return null;
  const v = Number(intPart) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(v)) return null;
  return neg ? -v : v;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number, mt: RegExpExecArray | null;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +mt[1]!; m = +mt[2]!; d = +mt[3]!; }
  else if ((mt = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(s))) { d = +mt[1]!; m = +mt[2]!; y = +mt[3]!; if (y < 100) y += 2000; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const HEADERS: Record<string, string[]> = {
  date: ['date', 'תאריך', 'תאריך עסקה', 'תאריך רכישה'],
  posting: ['posting_date', 'posting', 'תאריך חיוב', 'תאריך ערך'],
  description: ['description', 'desc', 'תיאור', 'תיאור פעולה', 'שם בית עסק', 'פרטים'],
  amount: ['amount', 'סכום', 'סכום עסקה'],
  debit: ['debit', 'חובה'],
  credit: ['credit', 'זכות'],
  currency: ['currency', 'מטבע'],
  reference: ['reference', 'ref', 'אסמכתא', 'אסמכתה'],
};
const norm = (h: string) => h.trim().toLowerCase().replace(/^﻿/, '');

/** ILS spellings seen in Israeli exports; anything else must be a 3-letter ISO code. */
export function normCurrency(raw: string): string {
  const c = raw.trim().replace(/["״']/g, '').toUpperCase();
  return c === '' || c === 'ILS' || c === 'NIS' || c === 'שח' || c === '₪' ? 'ILS' : c;
}

/** Rows that count as shekel spending in budgets and in GUARDIAN's independent check. */
export const SPEND_SQL = `kind IN ('expense','refund','loan-interest') AND COALESCE(dup_status,'') <> 'confirmed' AND currency = 'ILS'`;

/* ---------- classification ---------- */

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/סופר|שופרסל|רמי לוי|יוחננוף|מגה|ויקטורי|טיב טעם|supermarket|grocer/i, 'מכולת'],
  [/מסעדה|קפה|פיצה|וולט|wolt|תן ביס|מקדונלד|cafe|restaurant/i, 'אוכל בחוץ'],
  [/דלק|פז|סונול|דור אלון|רב קו|רכבת|אוטובוס|חניה|gett|uber|fuel|parking/i, 'תחבורה'],
  [/חשמל|מים|ארנונה|גז|אינטרנט|סלקום|פרטנר|הוט|בזק|פלאפון|electric|internet/i, 'חשבונות'],
  [/שכר דירה|משכנתא|rent|mortgage/i, 'דיור'],
  [/רופא|מכבי|כללית|מאוחדת|לאומית|סופר פארם|בית מרקחת|pharm/i, 'בריאות'],
  [/נטפליקס|ספוטיפיי|netflix|spotify|disney|youtube|סינמה/i, 'בילוי ומנויים'],
  [/ריבית|interest/i, 'ריבית'],
];

/**
 * Whole-word matcher. Substring matching misfired on real descriptions ("ביטוח" and "ביטול" contained ביט,
 * "DIRECT DEBIT" contained bit). A single Hebrew prefix letter (ב ל ה ו מ ש כ) is allowed, so "בביט" still matches.
 */
const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])[בלהומשכ]?(?:${alts})(?![\\p{L}\\p{N}])`, 'iu');
const RE_REFUND = word('החזר|זיכוי|refund|chargeback');
const RE_INTEREST = word('ריבית|interest');
const RE_PRINCIPAL = word('קרן|principal');
/** Card issuers as they appear on the bank side; matched alone they mean a card bill being paid. */
const RE_ISSUER = word('ישראכרט|isracard|כאל|cal|ויזה כאל|מקס איט|max it|לאומי קארד|leumi card|דיינרס|diners|אמריקן אקספרס|american express|amex');
const RE_CARD_WORD = word('ויזה|visa|mastercard|מסטרקארד|מקס|max|כרטיס|כרטיס אשראי|כרטיסי אשראי');
/** Fees charged by an issuer are spending, not a bill payment ("דמי כרטיס ישראכרט"). */
const RE_FEE = word('דמי|דמי כרטיס|עמלה|עמלת|fee|fees');
const RE_PAYMENT = word('חיוב|חיוב כרטיס|settle|settlement|payment|תשלום');
const RE_TRANSFER = word('העברה|transfer|bit|ביט|paybox|פייבוקס');
/** Salary words; "שכר דירה" is rent, not salary. */
const RE_SALARY = /(?<![\p{L}\p{N}])[בלהומשכ]?(?:משכורת|salary|שכר(?!\s*דירה))(?![\p{L}\p{N}])/iu;

export function classify(description: string, amountAgorot: number): { kind: Transaction['kind']; category: string } {
  const d = description;
  if (RE_REFUND.test(d) && amountAgorot > 0) return { kind: 'refund', category: categoryOf(d) };
  if (RE_INTEREST.test(d) && amountAgorot < 0) return { kind: 'loan-interest', category: 'ריבית' };
  if (RE_PRINCIPAL.test(d) && amountAgorot < 0) return { kind: 'loan-principal', category: 'החזר הלוואה' };
  if (amountAgorot < 0 && !RE_FEE.test(d) && (RE_ISSUER.test(d) || (RE_CARD_WORD.test(d) && RE_PAYMENT.test(d)))) return { kind: 'card-settlement', category: 'סילוק כרטיס' };
  if (RE_TRANSFER.test(d) && !RE_SALARY.test(d)) return { kind: 'transfer', category: 'העברות' };
  if (amountAgorot > 0) return { kind: 'income', category: RE_SALARY.test(d) ? 'הכנסה' : 'הכנסה אחרת' };
  return { kind: 'expense', category: categoryOf(d) };
}
function categoryOf(d: string): string { for (const [re, c] of CATEGORY_RULES) if (re.test(d)) return c; return 'אחר'; }

const normDesc = (s: string) => s.toLowerCase().replace(/[\s\-_*#.,]+/g, ' ').trim();

/* ---------- store ---------- */

interface TxRow {
  id: string; date: string; posting_date: string | null; description: string; amount_agorot: number; currency: string; account: string;
  category: string; kind: string; flag: string; possible_duplicate_of: string | null; source: string;
}
const toTx = (r: TxRow): Transaction => ({
  id: r.id, date: r.date, postingDate: r.posting_date, description: r.description, amountAgorot: r.amount_agorot, currency: r.currency,
  account: r.account, category: r.category, kind: r.kind as Transaction['kind'], flag: r.flag as MoneyFlag, possibleDuplicateOf: r.possible_duplicate_of, source: r.source,
});

export class MoneyStore {
  constructor(private db: Db) {}

  import(csv: string, account: string, source = 'csv-import'): ImportResult {
    const acct = account.trim().slice(0, 40) || 'חשבון';
    if (acct.replace(/\D/g, '').length >= 6) throw new Error('שם החשבון נראה כמו מספר חשבון — השתמש בכינוי בלבד');
    const rows = parseCsv(csv);
    const result: ImportResult = { batchId: newId('batch'), inserted: 0, duplicatesSkipped: 0, possibleDuplicates: 0, rejected: [] };
    if (rows.length < 2) { result.rejected.push({ row: 1, reason: 'הקובץ ריק או חסרה שורת כותרת' }); return result; }
    const header = rows[0]!.map(norm);
    const col: Record<string, number> = {};
    for (const [k, names] of Object.entries(HEADERS)) { const i = header.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i; }
    if (col.date === undefined || col.description === undefined || (col.amount === undefined && col.debit === undefined && col.credit === undefined)) {
      result.rejected.push({ row: 1, reason: 'חסרות עמודות חובה: תאריך, תיאור וסכום (או חובה/זכות)' });
      return result;
    }
    const seen = new Map<string, number>();
    const firstOf = new Map<string, string>();
    const insert = this.db.prepare(`INSERT INTO transactions (id, ref_hash, date, posting_date, description, amount_agorot, currency, account, category, kind, flag, possible_duplicate_of, dup_status, source, batch_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.db.exec('BEGIN');
    try {
      rows.slice(1).forEach((r, i) => {
        const rowNo = i + 2;
        const date = parseDate(r[col.date!] ?? '');
        if (!date) return result.rejected.push({ row: rowNo, reason: 'תאריך לא תקין' });
        const description = (r[col.description!] ?? '').trim().slice(0, 200);
        if (!description) return result.rejected.push({ row: rowNo, reason: 'חסר תיאור' });
        let amt: number | null;
        if (col.amount !== undefined && (r[col.amount] ?? '').trim() !== '') amt = parseAmountAgorot(r[col.amount]!);
        else {
          const dr = col.debit !== undefined && (r[col.debit] ?? '').trim() ? parseAmountAgorot(r[col.debit]!) : 0;
          const cr = col.credit !== undefined && (r[col.credit] ?? '').trim() ? parseAmountAgorot(r[col.credit]!) : 0;
          amt = dr === null || cr === null ? null : Math.abs(cr) - Math.abs(dr);
        }
        if (amt === null || amt === 0) return result.rejected.push({ row: rowNo, reason: 'סכום לא תקין' });
        const currency = normCurrency(col.currency !== undefined ? r[col.currency] ?? '' : '');
        if (!/^[A-Z]{3}$/.test(currency)) return result.rejected.push({ row: rowNo, reason: 'מטבע לא תקין' });
        const posting = col.posting !== undefined ? parseDate(r[col.posting] ?? '') : null;
        const reference = col.reference !== undefined ? (r[col.reference] ?? '').trim() : '';
        const base = [acct, date, amt, currency, normDesc(description), reference].join('|');
        const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
        const refHash = createHash('sha256').update(`${base}|#${n}`).digest('hex');
        if (this.db.prepare('SELECT 1 FROM transactions WHERE ref_hash = ?').get(refHash)) return void result.duplicatesSkipped++;
        const { kind, category } = classify(description, amt);
        const near = this.db.prepare(
          `SELECT id FROM transactions WHERE account = ? AND amount_agorot = ? AND currency = ? AND ABS(julianday(date) - julianday(?)) <= 1 AND batch_id <> ? LIMIT 1`,
        ).get(acct, amt, currency, date, result.batchId) as { id: string } | undefined;
        const id = newId('tx');
        if (n === 1) firstOf.set(base, id);
        const dupOf = n > 1 ? firstOf.get(base) ?? null : near?.id ?? null; // same row repeated in one file, or same amount/date across batches
        insert.run(id, refHash, date, posting, description, amt, currency, acct, category, kind, 'reported', dupOf, dupOf ? 'suspected' : null, source, result.batchId, nowIso());
        this.db.prepare('INSERT INTO tx_audit (id, tx_id, at, change) VALUES (?,?,?,?)').run(newId('ta'), id, nowIso(), `imported batch=${result.batchId} source=${source}`);
        result.inserted++;
        if (dupOf) result.possibleDuplicates++;
      });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return result;
  }

  setBalance(account: string, amountAgorot: number, flag: MoneyFlag, asOf: string): void {
    if (!Number.isSafeInteger(amountAgorot)) throw new Error('invalid amount');
    this.db.prepare('INSERT INTO balances (account, amount_agorot, flag, as_of) VALUES (?,?,?,?) ON CONFLICT(account) DO UPDATE SET amount_agorot=excluded.amount_agorot, flag=excluded.flag, as_of=excluded.as_of').run(account.slice(0, 40), amountAgorot, flag, asOf);
  }
  setBudget(category: string, limitAgorot: number): void {
    if (!Number.isSafeInteger(limitAgorot) || limitAgorot < 0) throw new Error('invalid limit');
    this.db.prepare('INSERT INTO budgets (category, limit_agorot) VALUES (?,?) ON CONFLICT(category) DO UPDATE SET limit_agorot=excluded.limit_agorot').run(category.slice(0, 40), limitAgorot);
  }

  count(): number { return (this.db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c; }

  transactions(limit = 200): Transaction[] {
    return (this.db.prepare('SELECT * FROM transactions ORDER BY date DESC, created_at DESC LIMIT ?').all(limit) as unknown as TxRow[]).map(toTx);
  }

  /** Spend per category for a YYYY-MM month, in shekels: expenses, refunds and interest count; transfers, settlements,
   *  loan principal, confirmed duplicates and non-ILS rows do not (other currencies are never added to ₪ totals). */
  monthlySpend(month: string): Map<string, number> {
    const rows = this.db.prepare(
      `SELECT category, kind, amount_agorot FROM transactions WHERE substr(date,1,7) = ? AND ${SPEND_SQL}`,
    ).all(month) as Array<{ category: string; kind: string; amount_agorot: number }>;
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) - r.amount_agorot);
    return m;
  }

  view(now = new Date()): MoneyView {
    const has = this.count() > 0;
    const month = jerusalemDay(now).slice(0, 7);
    const spent = this.monthlySpend(month);
    const limits = this.db.prepare('SELECT category, limit_agorot FROM budgets').all() as Array<{ category: string; limit_agorot: number }>;
    const cats = new Set([...limits.map((l) => l.category), ...spent.keys()]);
    const budget = [...cats].map((category) => ({
      category, limitAgorot: limits.find((l) => l.category === category)?.limit_agorot ?? 0, spentAgorot: Math.max(0, spent.get(category) ?? 0), flag: 'reported' as MoneyFlag,
    })).sort((a, b) => b.spentAgorot - a.spentAgorot);
    const balances = (this.db.prepare('SELECT * FROM balances ORDER BY account').all() as Array<{ account: string; amount_agorot: number; flag: string; as_of: string }>)
      .map((b) => ({ account: b.account, amountAgorot: b.amount_agorot, flag: b.flag as MoneyFlag, asOf: b.as_of }));
    const asOf = (this.db.prepare('SELECT MAX(created_at) AS t FROM transactions').get() as { t: string | null }).t;
    const duplicates = (this.db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE dup_status = 'suspected'").get() as { c: number }).c;
    return {
      asOf, hasData: has, balances, budget, transactions: this.transactions(200), duplicates,
      emptyReasonHe: has ? null : 'עדיין לא יובאו נתונים. ייבא קובץ CSV של עסקאות כדי להתחיל — אין יתרות או הוצאות מומצאות.',
    };
  }
}

export interface DupPair { txId: string; duplicateOf: string; description: string; amountAgorot: number; date: string }
export function suspectedDuplicates(db: Db): DupPair[] {
  return (db.prepare("SELECT id, possible_duplicate_of, description, amount_agorot, date FROM transactions WHERE dup_status = 'suspected' ORDER BY date DESC").all() as Array<{ id: string; possible_duplicate_of: string; description: string; amount_agorot: number; date: string }>)
    .map((r) => ({ txId: r.id, duplicateOf: r.possible_duplicate_of, description: r.description, amountAgorot: r.amount_agorot, date: r.date }));
}
/** Guarded write: only called after an approval. Every change is written to the transaction audit trail. */
export function resolveDuplicates(db: Db, txIds: string[], decision: 'confirmed' | 'dismissed', approvalId: string): number {
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const id of txIds) {
      const r = db.prepare("UPDATE transactions SET dup_status = ? WHERE id = ? AND dup_status = 'suspected'").run(decision, id);
      if (Number(r.changes) > 0) {
        n++;
        db.prepare('INSERT INTO tx_audit (id, tx_id, at, change) VALUES (?,?,?,?)').run(newId('ta'), id, nowIso(), `dup_status=${decision} approval=${approvalId}`);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}
