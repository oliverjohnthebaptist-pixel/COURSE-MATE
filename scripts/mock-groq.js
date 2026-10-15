// DEV ONLY: a fake Groq for testing without internet. Behaves like the REAL service in 2026:
//  - retired models (llama/qwen/gemma/mixtral) answer 404, only openai/gpt-oss-20b and -120b work
//  - 8,000 tokens per minute per model (free tier): too much -> 429 with "try again in Xs"
//  - sometimes returns broken JSON, to test the repair logic
// Usage: node -r ./scripts/mock-groq.js server.js     (env MOCK_TPM=8000, MOCK_BADJSON=0.1)
const Module = require('module'); const orig = Module._load;
const TPM = +process.env.MOCK_TPM || 8000, BAD = +(process.env.MOCK_BADJSON || 0.08), DELAY = +(process.env.MOCK_DELAY || 120);
const OK = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
const used = new Map(); const stats = (global.__mockStats = { calls: 0, r429: 0, r404: 0, bad: 0, maxConc: 0, conc: 0 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function err(status, message, headers = {}) { const e = new Error(message); e.status = status; e.headers = { get: k => headers[k.toLowerCase()] }; return e; }
function words(n) { return Array.from({ length: n }, (_, i) => ['software', 'module', 'unit', 'learn', 'system', 'design', 'process', 'student'][i % 8]).join(' '); }

function tmaReply(user) {
  const m = /COURSE MATERIAL EXCERPTS:\n([\s\S]*?)\n\nQUESTION: ([\s\S]*?)\n([A-D]\) [\s\S]*?)\n\n/.exec(user); if (!m) return null;
  const toks = t => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  const q = toks(m[2] + ' ' + m[3]); let page = 0, best = null, bestS = -1;
  m[1].split(/\[PAGE ~?(\d+)\]\n/).forEach((chunk, i, arr) => { if (i % 2 === 1) { const pg = +chunk; const body = arr[i + 1] || ''; body.split(/(?<=[.!?])\s+/).forEach(sen => { const t = toks(sen); let sc = 0; t.forEach(w => { if (q.has(w)) sc++; }); if (sc > bestS && sen.length > 30) { bestS = sc; best = sen.trim(); page = pg; } }); } });
  if (!best || bestS < 2) return JSON.stringify({ letter: 'none', evidence: '', page: 0, reason: 'not found' });
  const bt = toks(best); let L = 'a', ls = -1;
  m[3].split('\n').forEach(line => { const mm = /^([A-D])\) (.*)$/.exec(line); if (!mm) return; let sc = 0; toks(mm[2]).forEach(w => { if (bt.has(w)) sc++; }); if (sc > ls) { ls = sc; L = mm[1].toLowerCase(); } });
  return JSON.stringify({ letter: L, evidence: best, page, reason: 'matches the excerpt' });
}

function reply(user) {
  const t = tmaReply(user); if (t) return t;
  if (/single word OK/i.test(user)) return 'OK';
  if (/"notes"/.test(user)) {
    const secs = (/in order: ([^\n]+?)\.\n|for each of these sections, in order: ([^\n]+?)\./.exec(user) || [])[1] || '';
    const list = secs ? secs.split('; ').map(x => x.trim()).filter(Boolean) : [];
    return JSON.stringify({ notes: 'NOTES ' + words(170), sections: list.map(x => ({ num: x.split(' ')[0], title: x.split(' ').slice(1).join(' '), summary: 'Section summary. ' + words(40), page: 0 })), key_points: [{ point: 'KP part', explanation: 'x', page: 0 }], definitions: [{ term: 'Term', meaning: 'Meaning', page: 0 }] });
  }
  if (/"overview"/.test(user)) return JSON.stringify({ title: 'Module theme', overview: 'OVERVIEW ' + words(160) });
  if (/"explanation"/.test(user) && /"summary"/.test(user)) {
    const secs = (/for each of these sections, in order: ([^\n]+?)\.\n/.exec(user) || [])[1] || '';
    const list = secs ? secs.split('; ').map(x => x.trim()).filter(Boolean) : [];
    return JSON.stringify({ summary: 'UNIT SUMMARY ' + words(100), explanation: ('EXPLANATION ' + words(110) + '\n\n').repeat(3).trim(), sections: list.map(x => ({ num: x.split(' ')[0], title: x.split(' ').slice(1).join(' '), summary: 'Section summary. ' + words(40), page: 0 })), key_points: [1, 2, 3, 4].map(i => ({ point: 'Key point ' + i, explanation: 'why', page: 0 })), definitions: [{ term: 'Term', meaning: 'Meaning', page: 0 }] });
  }
  if (/Write a clear explanation/.test(user)) return 'PLAIN EXPLANATION ' + words(200);
  return JSON.stringify({ found: true, letter: 'b', answer_letter: 'b', quote: 'mock', evidence: '', why: 'mock', reason: 'mock', answer: 'mock answer', explanation: 'mock', suggestions: ['a?', 'b?', 'c?'] });
}
class FakeGroq {
  constructor() {
    this.chat = { completions: { create: async (o) => {
      stats.calls++; stats.conc++; stats.maxConc = Math.max(stats.maxConc, stats.conc);
      try {
        await sleep(DELAY);
        if (!OK.has(o.model)) { stats.r404++; throw err(404, `The model \`${o.model}\` has been decommissioned and is no longer supported. model_not_found`); }
        const user = JSON.stringify(o.messages); const inTok = Math.ceil(user.length / 3.3), outTok = Math.min(o.max_tokens || 500, 700);
        const rec = used.get(o.model) || []; const now = Date.now(); while (rec.length && rec[0][0] < now - 60000) rec.shift();
        const sum = rec.reduce((a, x) => a + x[1], 0);
        if (sum + inTok + outTok > TPM) { stats.r429++; const wait = Math.max(1, Math.ceil((rec[0][0] + 60000 - now) / 1000)); throw err(429, `Rate limit reached for model \`${o.model}\` tokens per minute (TPM): Limit ${TPM}. Please try again in ${wait}s.`, { 'retry-after': String(wait) }); }
        rec.push([now, inTok + outTok]); used.set(o.model, rec);
        let content = reply(user.replace(/\\n/g, '\n').replace(/\\"/g, '"'));
        if (o.stream) { return (async function* () { for (const w of content.split(' ')) yield { choices: [{ delta: { content: w + ' ' } }] }; })(); }
        if (/"explanation"|"notes"/.test(user) && Math.random() < BAD) { stats.bad++; content = content.slice(0, Math.floor(content.length * 0.7)); }
        return { choices: [{ message: { content } }], usage: { total_tokens: inTok + outTok } };
      } finally { stats.conc--; }
    } } };
  }
}
Module._load = function (req, ...a) { if (req === 'groq-sdk') { const F = FakeGroq; F.Groq = FakeGroq; F.default = FakeGroq; return F; } return orig.call(this, req, ...a); };
