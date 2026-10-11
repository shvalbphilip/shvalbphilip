#!/usr/bin/env node
// Scans every git-tracked file of the repository for secret-, IBAN- and card-shaped strings.
// No dependencies. Exit 1 on any hit so `npm run check` and CI fail. Usage: node scripts/secret-scan.mjs [repo-root]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

const self = relative(root, new URL(import.meta.url).pathname);
const SKIP = [
  (f) => f === self,
  (f) => /(^|\/)package-lock\.json$/.test(f),
  (f) => /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|db|sqlite)$/i.test(f),
];

/** Luhn check so an ordinary 13–19 digit number (timestamps, ids) is not reported as a card. */
const luhn = (digits) => {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = Number(digits[i]); if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return sum % 10 === 0 && !/^(\d)\1+$/.test(digits);
};

const PATTERNS = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ['OpenAI-style key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Israeli IBAN', /\bIL\d{2}(?:[ -]?\d){19}\b/gi],
  // contiguous 13–19 digits, or 4-digit groups (4-4-4-x); free-form digit runs would flag SVG path data and the like
  ['payment card number', /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2}(?:[ -]\d{1,7})?)\b/g, (m) => luhn(m.replace(/[ -]/g, ''))],
];

const hits = [];
for (const f of files) {
  if (SKIP.some((s) => s(f))) continue;
  let text;
  try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue; // binary
  for (const [name, re, extra] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (extra && !extra(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${f}:${line}: ${name} (${m[0].slice(0, 6)}…)`);
    }
  }
}

if (hits.length) {
  console.error(`secret-scan: ${hits.length} finding(s) in tracked files:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log(`secret-scan: ${files.length} tracked files clean`);
