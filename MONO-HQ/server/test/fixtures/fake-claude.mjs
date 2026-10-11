#!/usr/bin/env node
// Test double for the `claude` CLI. Emits stream-json like `claude -p --output-format stream-json --verbose`.
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.FAKE_VERSION ?? '2.1.296 (Claude Code)'); process.exit(0); }
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, env: { sub: process.env.CLAUDE_CODE_SUBAGENT_MODEL, force: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, token: process.env.MONO_ACCESS_TOKEN ?? null } }) + '\n');
const mode = process.env.FAKE_MODE ?? 'ok';
const model = process.env.FAKE_MODEL ?? 'claude-sonnet-5-5';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let stdin = ''; try { stdin = readFileSync(0, 'utf8'); } catch {}
if (mode === 'hang') { out({ type: 'system', subtype: 'init', model }); setInterval(() => {}, 1000); }
else if (mode === 'crash') { process.stderr.write('boom'); process.exit(2); }
else {
  out({ type: 'system', subtype: 'init', model, tools: [] });
  out({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://www.boi.org.il/x?secret=1' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } });
  const text = process.env.FAKE_TEXT ?? JSON.stringify({ publicSummary: 'סיכום בדיקה', summaryHe: 'הכל תקין', nextSteps: ['להמשיך'], answerHe: 'תשובה', items: [] });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: Number(process.env.FAKE_COST ?? '0.04'), modelUsage: { [process.env.FAKE_RESULT_MODEL ?? model]: { inputTokens: 1 } } });
}
