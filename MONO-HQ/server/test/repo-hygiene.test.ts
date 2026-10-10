import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../..', import.meta.url).pathname;
const tracked = () => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

describe('repository hygiene (the repo is PUBLIC)', () => {
  it('ignores runtime data, databases and env files', () => {
    const ign = readFileSync(`${root}.gitignore`, 'utf8');
    for (const p of ['.env', '*.db', 'data/', 'node_modules/']) expect(ign).toContain(p);
  });
  it('never tracks databases, env files, or the data directory', () => {
    const bad = tracked().filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example') || /\.(db|sqlite)(-wal|-shm)?$/.test(f) || /(^|\/)MONO-HQ\/data\//.test(f));
    expect(bad).toEqual([]);
  });
  it('contains no secrets, IBANs or card numbers in tracked text files', () => {
    const patterns: Array<[string, RegExp]> = [
      ['anthropic key', /sk-ant-[A-Za-z0-9_-]{10,}/], ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}/], ['aws key', /AKIA[0-9A-Z]{16}/],
      ['IBAN', /\bIL\d{2}(?:[ ]?\d){19}\b/], ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ];
    for (const f of tracked().filter((x) => /\.(ts|tsx|json|md|csv|html|css|example|mjs)$/.test(x) && !x.endsWith('package-lock.json') && !x.includes('hygiene.test'))) {
      const text = readFileSync(`${root}${f}`, 'utf8');
      for (const [name, re] of patterns) expect(re.test(text), `${name} in ${f}`).toBe(false);
    }
  });
  it('sample fixtures are synthetic: no 9+ digit numbers', () => {
    const csv = readFileSync(`${root}MONO-HQ/fixtures/sample-transactions.csv`, 'utf8');
    expect(/\d{9,}/.test(csv)).toBe(false);
  });
});
