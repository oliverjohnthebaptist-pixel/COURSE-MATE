// CourseMate AI layer - every AI call in the app goes through here.
//  * Uses Groq models that exist TODAY (llama-3.1-8b / llama-3.3-70b / qwen3-32b were shut down in 2026 and answer "404").
//  * Knows Groq's per-minute token limit and spaces calls out, so students see progress instead of errors.
//  * Interactive calls (TMA, tutor, quiz) go before bulk calls (summaries).
//  * When something really fails, the message says WHY (busy / key / model) instead of a bare "404".
const MODELS = (process.env.AI_MODELS || 'openai/gpt-oss-20b,openai/gpt-oss-120b').split(',').map(s => s.trim()).filter(Boolean);
// GROQ_PLAN=free (default) or developer. "developer" = Groq pay-as-you-go: far higher limits, so summaries and TMA run many times faster.
const PLAN = String(process.env.GROQ_PLAN || 'free').toLowerCase();
const DEV = PLAN === 'developer' || PLAN === 'paid';
let TPM_MAX = parseInt(process.env.GROQ_TPM, 10) || (DEV ? 250000 : 8000);      // tokens per minute (free tier: 8,000)
let TPM = TPM_MAX, lastRate = 0, lastGrow = Date.now();
const RPM = parseInt(process.env.GROQ_RPM, 10) || (DEV ? 900 : 28);               // requests per minute (free tier: 30)
const MAX_CONC = parseInt(process.env.AI_CONCURRENCY, 10) || (DEV ? 8 : 4);

class AIError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dead = new Map();        // model -> time until we do not try it (not found / retired)
const cool = new Map();        // model -> time until its rate limit resets
const noExtras = new Set();    // models that rejected reasoning_effort / response_format

/* ------------------------------------------------------------ scheduler */
const win = [];                // {t, tokens} calls made in the last 60s
let active = 0;
const queue = [];              // waiting callers {prio, seq, run}
let seq = 0, pausedUntil = 0;
const now = () => Date.now();
function prune() { const cut = now() - 60000; while (win.length && win[0].t < cut) win.shift(); }
function used() { prune(); return win.reduce((a, x) => a + x.tokens, 0); }

function pump() {
  if (!queue.length) return;
  maybeGrow();
  if (now() < pausedUntil) { setTimeout(pump, Math.min(1000, pausedUntil - now() + 20)); return; }
  queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  const next = queue[0];
  prune();
  const budget = TPM * 0.88;
  const fits = used() + next.tokens <= budget || win.length === 0;      // an over-size call may go when the window is empty
  if (active < MAX_CONC && fits && win.length < RPM) {
    queue.shift(); active++;
    const rec = { t: now(), tokens: next.tokens }; win.push(rec);
    next.run(rec);
    setImmediate(pump);
  } else {
    const wait = win.length ? Math.max(250, Math.min(2000, win[0].t + 60000 - now() + 30)) : 300;
    setTimeout(pump, wait);
  }
}
function acquire(tokens, prio) { return new Promise(res => { queue.push({ prio, seq: seq++, tokens, run: rec => res(rec) }); pump(); }); }
function release(rec, actual) { active = Math.max(0, active - 1); if (rec && actual !== undefined) rec.tokens = actual; setImmediate(pump); }
function holdAll(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); }
function learnFrom429() {           // we sent more than Groq allows: remember roughly what WAS accepted in the last minute
  lastRate = now(); const u = used();
  if (u > 1500) TPM = Math.max(3500, Math.min(TPM, Math.floor(u * 0.85)));
  else TPM = Math.max(3500, Math.floor(TPM * 0.7));
}
function maybeGrow() { if (TPM < TPM_MAX && now() - lastRate > 180000 && now() - lastGrow > 60000) { TPM = Math.min(TPM_MAX, Math.ceil(TPM * 1.15)); lastGrow = now(); } }

/* ------------------------------------------------------------ helpers */
function retryAfterMs(e) {
  let ms = 0;
  try {
    const h = e && e.headers; const v = h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after']);
    if (v) ms = Number(v) * 1000;
    const m = /try again in\s*(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)\b/i.exec(String((e && e.message) || ''));
    if (!ms && m) ms = ((m[1] ? +m[1] * 60 : 0) + (m[3].toLowerCase() === 'ms' ? +m[2] / 1000 : +m[2])) * 1000;
  } catch {}
  return ms || 8000;
}
const statusOf = e => (e && (e.status || e.statusCode)) || 0;
const msgOf = e => String((e && e.message) || e || '').toLowerCase();
const isNotFound = e => statusOf(e) === 404 || /model_not_found|does not exist|decommission|no longer supported|not found/.test(msgOf(e)) && statusOf(e) !== 429;
const isReasoning = m => /gpt-oss/.test(m);

function extrasFor(model, json) {
  if (noExtras.has(model)) return {};
  const x = {};
  if (isReasoning(model)) x.reasoning_effort = 'low';
  if (json) x.response_format = { type: 'json_object' };
  return x;
}

/* ------------------------------------------------------------ main call */
async function complete(groq, opts = {}) {
  const patient = opts.patient || 0;
  for (let round = 0; ; round++) {
    try { return await completeOnce(groq, opts); }
    catch (e) {
      if (e && e.kind === 'rate' && round < patient && (e.waitSec || 30) <= 75) {
        const sec = Math.max(3, e.waitSec || 20); if (opts.onWait) { try { opts.onWait(sec, true); } catch {} }
        await sleep(sec * 1000 + 500); continue;
      }
      throw e;
    }
  }
}
async function completeOnce(groq, { system, user, messages, maxTokens = 800, json = false, priority = 0, temperature = 0.2, onWait } = {}) {
  if (!groq) throw new AIError('config', 'The AI is not set up yet (GROQ_API_KEY is missing).');
  const msgs = messages || [{ role: 'system', content: system || '' }, { role: 'user', content: user || '' }];
  const chars = msgs.reduce((a, m) => a + String(m.content || '').length, 0);
  const est = Math.ceil(chars / 3.3) + Math.ceil(maxTokens * 0.75);
  let sawRate = false, minWait = Infinity, sawNotFound = false, lastErr = null;

  for (const model of MODELS) {
    if ((dead.get(model) || 0) > now()) { sawNotFound = true; continue; }
    if ((cool.get(model) || 0) > now() + 25000) { sawRate = true; minWait = Math.min(minWait, cool.get(model) - now()); continue; }   // still rate limited a while: try the next model first
    for (let attempt = 1; attempt <= 3; attempt++) {
      const rec = await acquire(est, priority);
      let released = false;
      try {
        const body = Object.assign({ model, temperature, max_tokens: maxTokens, messages: msgs }, extrasFor(model, json));
        const comp = await groq.chat.completions.create(body);
        const total = comp && comp.usage && comp.usage.total_tokens;
        release(rec, total); released = true;
        const text = String((comp.choices && comp.choices[0] && comp.choices[0].message && comp.choices[0].message.content) || '').trim();
        if (!text) { lastErr = new AIError('empty', 'The AI returned an empty answer.'); if (attempt < 3) continue; break; }
        return text;
      } catch (e) {
        if (!released) release(rec, 0);
        lastErr = e; const st = statusOf(e);
        if (st === 401 || st === 403) throw new AIError('auth', 'The AI key was rejected. The site owner must check GROQ_API_KEY.', { status: st });
        if (isNotFound(e)) { dead.set(model, now() + 10 * 60000); sawNotFound = true; console.log(`[ai] model ${model} is not available (${st}) - trying the next one`); break; }
        if (st === 400 && !noExtras.has(model) && /reasoning|response_format|unsupported|not supported|json/.test(msgOf(e))) { noExtras.add(model); attempt--; continue; }
        if (st === 413 || /request too large|context length/.test(msgOf(e))) throw new AIError('toolarge', 'This part of the PDF was too large for the AI in one go.', { status: st });
        if (st === 429) {
          sawRate = true; const w = retryAfterMs(e); cool.set(model, now() + w); minWait = Math.min(minWait, w);
          learnFrom429(); holdAll(Math.min(w, 15000));
          if (w <= 20000 && attempt < 3) { if (onWait) { try { onWait(Math.ceil(w / 1000), true); } catch {} } await sleep(w + 300); continue; }
          break;                                                  // long wait: move on to the other model, it has its own limit
        }
        if (st >= 500 || !st) { if (attempt < 3) { await sleep(1200 * attempt); continue; } break; }
        break;
      }
    }
  }
  if (sawRate) {
    const sec = Math.max(5, Math.ceil((isFinite(minWait) ? minWait : 30000) / 1000));
    throw new AIError('rate', `The AI is busy right now (too many requests per minute). Please try again in about ${sec} seconds.`, { waitSec: sec, status: 429 });
  }
  if (sawNotFound && !lastErr) throw new AIError('model', 'The AI model is not available. The site owner must update AI_MODELS (see README).');
  if (lastErr && isNotFound(lastErr)) throw new AIError('model', 'The AI model is not available. The site owner must update AI_MODELS (see README).');
  throw lastErr instanceof AIError ? lastErr : new AIError('other', 'The AI could not answer right now. Please try again.', { cause: String((lastErr && lastErr.message) || '').slice(0, 160) });
}

/* ------------------------------------------------------------ streaming (tutor) */
async function stream(groq, { messages, maxTokens = 1200, temperature = 0.4, priority = 0, onToken } = {}) {
  if (!groq) throw new AIError('config', 'The AI is not set up yet (GROQ_API_KEY is missing).');
  const chars = messages.reduce((a, m) => a + String(m.content || '').length, 0);
  const est = Math.ceil(chars / 3.3) + maxTokens;
  let sawRate = false, minWait = Infinity, lastErr = null;
  for (const model of MODELS) {
    if ((dead.get(model) || 0) > now()) continue;
    if ((cool.get(model) || 0) > now() + 25000) { sawRate = true; minWait = Math.min(minWait, cool.get(model) - now()); continue; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rec = await acquire(est, priority); let released = false, sent = false, full = '';
      try {
        const body = Object.assign({ model, temperature, max_tokens: maxTokens, messages, stream: true }, extrasFor(model, false));
        const s = await groq.chat.completions.create(body);
        for await (const part of s) { const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content; if (d) { sent = true; full += d; if (onToken) onToken(d); } }
        release(rec, est); released = true; return full;
      } catch (e) {
        if (!released) release(rec, 0);
        lastErr = e; const st = statusOf(e);
        if (sent) throw new AIError('other', 'The connection to the AI dropped while answering. Please ask again.');
        if (st === 401 || st === 403) throw new AIError('auth', 'The AI key was rejected. The site owner must check GROQ_API_KEY.');
        if (isNotFound(e)) { dead.set(model, now() + 10 * 60000); break; }
        if (st === 400 && !noExtras.has(model)) { noExtras.add(model); attempt--; continue; }
        if (st === 429) { sawRate = true; const w = retryAfterMs(e); cool.set(model, now() + w); minWait = Math.min(minWait, w); learnFrom429(); holdAll(Math.min(w, 15000)); if (w <= 12000 && attempt < 2) { await sleep(w + 300); continue; } break; }
        if (attempt < 2 && (st >= 500 || !st)) { await sleep(1200); continue; }
        break;
      }
    }
  }
  if (sawRate) { const sec = Math.max(5, Math.ceil((isFinite(minWait) ? minWait : 30000) / 1000)); throw new AIError('rate', `The AI is busy right now (too many requests per minute). Please try again in about ${sec} seconds.`, { waitSec: sec }); }
  throw new AIError('other', 'The AI could not answer right now. Please try again.');
}

function friendly(e) { return e instanceof AIError ? e.message : String((e && e.message) || e || 'Something went wrong.').slice(0, 220); }
function setTPM(n) { if (n && n > 0) { TPM_MAX = n; TPM = n; } }
function status() { return { models: MODELS, tpm: TPM, tpmMax: TPM_MAX, rpm: RPM, concurrency: MAX_CONC, usedTokens: used(), waiting: queue.length, active }; }

module.exports = { complete, stream, AIError, friendly, status, setTPM, MODELS };
