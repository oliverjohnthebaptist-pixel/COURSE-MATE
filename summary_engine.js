// Summary engine v2
//  * reads EVERY page of a unit (long units are split into chunks, each chunk is summarised, then one final call writes the explanation)
//  * runs several units - and several courses - at the same time, as fast as the AI limits allow
//  * a unit is never left blank: bad JSON is repaired, retried, and finally falls back to a plain-text explanation
//  * failed units are retried automatically (waiting out rate limits) and reported with the real reason
const AI = require('./ai');
const O = require('./outline');

const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const SYS = 'You summarise course material using ONLY the text provided. Never add outside facts. Write clearly, in simple words, for a Nigerian university student. Output one JSON object and nothing else.';
const CHUNK_MAX = parseInt(process.env.SUMMARY_CHUNK_CHARS, 10) || 7000;   // characters of PDF text per AI call
const SINGLE_MAX = 9000;                                                  // a unit this short is summarised in one call
const POOL = parseInt(process.env.SUMMARY_POOL, 10) || 4;                 // units in flight at once (per server)

/* ------------------------------------------------------------ JSON that survives messy AI output */
function parseLoose(raw) {
  let r = String(raw || '').replace(/```json|```/gi, '').trim();
  const a = r.indexOf('{'); if (a < 0) return null;
  r = r.slice(a);
  const b = r.lastIndexOf('}'); const body = b > 0 ? r.slice(0, b + 1) : r;
  const tries = [body, body.replace(/,\s*([}\]])/g, '$1')];
  for (const t of tries) { try { return JSON.parse(t); } catch {} }
  // truncated answer: cut back to the last complete property and close the object
  let t = r;
  for (let i = 0; i < 40; i++) {
    const cut = Math.max(t.lastIndexOf('",'), t.lastIndexOf('],'), t.lastIndexOf('},'));
    if (cut < 1) break;
    t = t.slice(0, cut + 1);
    const open = (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length, openB = (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length;
    const fixed = t.replace(/,\s*$/, '') + ']'.repeat(Math.max(0, open)) + '}'.repeat(Math.max(0, openB));
    try { return JSON.parse(fixed); } catch {}
  }
  return null;
}
async function jsonCall(groq, user, maxTokens, onWait) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await AI.complete(groq, { system: SYS, user: attempt > 1 ? user + '\n\nIMPORTANT: return ONLY one valid JSON object. No text before or after it.' : user, maxTokens, json: true, priority: 1, temperature: 0.2, onWait, patient: 3 });
    const j = parseLoose(raw); if (j) return j;
  }
  return null;
}

/* ------------------------------------------------------------ the text of a unit, in chunks that cover everything */
function stripper(m) { return t => { t = String(t || '').replace(/\s+/g, ' '); return (m.head ? t.split(m.head).join(' ') : t).replace(/\s+/g, ' ').trim(); }; }

function unitChunks(m, unit) {
  const strip = stripper(m);
  const segs = [];                                     // {label, page, text}
  const secs = unit.sections || [];
  if (secs.length >= 2) {
    if (secs[0].page > unit.start) {
      const t = strip(m.raw.slice(unit.start - 1, secs[0].page - 1).join(' '));
      if (t.length > 60) segs.push({ label: `INTRODUCTION | pages ${unit.start}-${secs[0].page - 1}`, page: unit.start, text: t });
    }
    secs.forEach((s, i) => {
      const parts = O.sectionText(m.raw, unit, i);
      const t = strip(parts.map(p => p.text).join(' '));
      if (t.length > 20) segs.push({ label: `SECTION ${s.num} ${s.title} | pages ${s.page}-${parts.length ? parts[parts.length - 1].page : s.page}`, page: s.page, text: t, sec: s });
    });
  } else {
    for (let p = unit.start; p <= unit.end; p++) { const t = strip(m.raw[p - 1] || ''); if (t.length > 40) segs.push({ label: `PAGE ${p}`, page: p, text: t }); }
  }
  // split any oversized segment, then pack segments into chunks
  const pieces = [];
  segs.forEach(s => {
    if (s.text.length <= CHUNK_MAX) { pieces.push(s); return; }
    const n = Math.ceil(s.text.length / CHUNK_MAX), size = Math.ceil(s.text.length / n);
    for (let i = 0; i < n; i++) {
      let a = i * size, b = Math.min(s.text.length, (i + 1) * size);
      if (i > 0) { const sp = s.text.indexOf(' ', a); if (sp > 0 && sp - a < 200) a = sp + 1; }
      pieces.push({ label: s.label + (n > 1 ? ` (part ${i + 1}/${n})` : ''), page: s.page, text: s.text.slice(a, b), sec: i === 0 ? s.sec : null });
    }
  });
  const chunks = []; let cur = null;
  pieces.forEach(p => {
    if (!cur || cur.chars + p.text.length > CHUNK_MAX) { cur = { parts: [], chars: 0, secs: [], pages: [] }; chunks.push(cur); }
    cur.parts.push(p); cur.chars += p.text.length; if (p.sec) cur.secs.push(p.sec); cur.pages.push(p.page);
  });
  chunks.forEach(c => { c.text = c.parts.map(p => `[${p.label}]\n${p.text}`).join('\n\n'); c.from = Math.min(...c.pages); c.to = Math.max(...c.pages); });
  return chunks;
}

/* ------------------------------------------------------------ one unit */
const extractive = (t, n = 2) => flat(t).split(/(?<=[.!?])\s+/).slice(0, n).join(' ').slice(0, 420);

async function summariseUnit({ groq, m, mod, unit, onWait }) {
  const chunks = unitChunks(m, unit);
  if (!chunks.length) throw new AI.AIError('empty', `No readable text was found on pages ${unit.start}-${unit.end}.`);
  const secs = unit.sections || []; const hasSec = secs.length >= 2;
  const clamp = pg => { pg = parseInt(pg, 10); return pg >= unit.start && pg <= unit.end ? pg : unit.start; };
  const head = `COURSE MATERIAL - Module ${mod.n} Unit ${unit.n}: ${unit.title}`;
  const total = chunks.reduce((a, c) => a + c.chars, 0);
  let j = null, sectionsOut = [], notesUsed = false;

  const secInstr = list => list.length ? `Give exactly one entry in "sections" for each of these sections, in order: ${list.map(s => `${s.num} ${s.title}`).join('; ')}.` : `In "sections" list 2-4 main ideas of this text (leave "num" empty, give a short "title" for each).`;

  if (chunks.length === 1 && total <= SINGLE_MAX) {
    const user = `${head} (pages ${unit.start}-${unit.end}):\n${chunks[0].text}\n\n` +
      `Return ONLY JSON:\n{"summary":"90-130 words summarising this whole unit","explanation":"280-380 words that EXPLAIN this unit expressly, like a good lecturer teaching a student who has not read it: what it is about, how each main idea works, why it matters, and one simple example taken from the text. Write 3-4 short paragraphs separated by a blank line.","sections":[{"num":"","title":"","summary":"3-4 sentences explaining what this section teaches","page":0}],"key_points":[{"point":"","explanation":"one sentence","page":0}],"definitions":[{"term":"","meaning":"","page":0}]}\n` +
      `${secInstr(hasSec ? secs : [])}\nGive 4-5 key_points and up to 5 definitions (only terms the text actually defines). Do not skip any section. Use simple words.`;
    j = await jsonCall(groq, user, 3000, onWait);
    sectionsOut = (j && j.sections) || [];
  } else {
    // map: every chunk -> detailed notes (parallel, paced by the AI layer)
    notesUsed = true;
    const parts = await Promise.all(chunks.map((c, i) => {
      const user = `${head} - part ${i + 1} of ${chunks.length} (pages ${c.from}-${c.to}):\n${c.text}\n\n` +
        `Return ONLY JSON:\n{"notes":"detailed notes of 160-230 words covering EVERY idea, term, step, list and example in this text, in order, in simple words","sections":[{"num":"","title":"","summary":"3-4 sentences explaining what this section teaches","page":0}],"key_points":[{"point":"","explanation":"one sentence","page":0}],"definitions":[{"term":"","meaning":"","page":0}]}\n` +
        `${secInstr(c.secs)}\nUp to 3 key_points and 3 definitions (only terms this text defines). Use only this text.`;
      return jsonCall(groq, user, 1500, onWait).then(r => ({ c, r }));
    }));
    const okParts = parts.filter(p => p.r && (p.r.notes || p.r.sections));
    if (!okParts.length) j = null;
    else {
      const notes = parts.map(({ c, r }, i) => `PART ${i + 1} (pages ${c.from}-${c.to}): ${flat((r && r.notes) || extractive(c.text, 6))}`).join('\n\n');
      const cand = { kp: [], df: [] };
      okParts.forEach(({ r }) => { (r.key_points || []).forEach(k => k && k.point && cand.kp.push(k)); (r.definitions || []).forEach(d => d && d.term && d.meaning && cand.df.push(d)); });
      sectionsOut = okParts.flatMap(({ r }) => r.sections || []);
      const user = `${head} (pages ${unit.start}-${unit.end}). Notes taken from the whole unit:\n${notes}\n\n` +
        `Return ONLY JSON:\n{"summary":"90-130 words summarising this whole unit","explanation":"280-380 words that EXPLAIN this unit expressly, like a good lecturer teaching a student who has not read it: what it is about, how each main idea works, why it matters, and one simple example taken from the notes. Write 3-4 short paragraphs separated by a blank line.","key_points":[{"point":"","explanation":"one sentence","page":0}],"definitions":[{"term":"","meaning":"","page":0}]}\n` +
        `Give the 4-5 most important key_points and up to 5 definitions. Cover every part of the unit. Use only the notes.`;
      j = await jsonCall(groq, user, 2200, onWait);
      if (j) { j.key_points = (j.key_points && j.key_points.length ? j.key_points : cand.kp); j.definitions = (j.definitions && j.definitions.length ? j.definitions : cand.df); }
      else j = { summary: extractive(notes.replace(/PART \d+ \(pages [\d-]+\): /g, ''), 4), explanation: notes.replace(/PART \d+ \(pages [\d-]+\): /g, '').split('\n\n').join('\n\n'), key_points: cand.kp, definitions: cand.df };
    }
  }

  if (!j || !(j.explanation || j.summary)) {            // last resort: plain text, no JSON at all
    const text = chunks.map(c => c.text).join('\n\n').slice(0, 9000);
    const plain = await AI.complete(groq, { system: 'You explain course material using ONLY the text provided, in simple words for a university student.', user: `${head}:\n${text}\n\nWrite a clear explanation of this unit in 3-4 short paragraphs (about 300 words) that covers all its main ideas. Plain text only.`, maxTokens: 1200, priority: 1, onWait, patient: 3 });
    j = { summary: extractive(plain, 4), explanation: plain, key_points: [], definitions: [] };
  }

  // sections: keep the outline's own numbering and page numbers; never leave one empty
  let sections;
  if (hasSec) {
    const byNum = new Map((sectionsOut || []).filter(s => s).map(s => [String(s.num || '').trim(), s]));
    const segText = new Map(); chunks.forEach(c => c.parts.forEach(p => { if (p.sec) segText.set(p.sec.num, p.text); }));
    sections = secs.map((s, i) => { const r = byNum.get(s.num) || (sectionsOut || [])[i] || {}; return { num: s.num, title: s.title, summary: flat(r.summary) || extractive(segText.get(s.num) || '', 2), page: s.page }; });
  } else sections = (sectionsOut || []).filter(s => s && (s.title || s.summary)).slice(0, 6).map(s => ({ num: '', title: flat(s.title), summary: flat(s.summary), page: clamp(s.page) }));

  return {
    n: unit.n, title: unit.title, pages: `${unit.start}-${unit.end}`, start: unit.start, end: unit.end,
    explanation: String(j.explanation || '').replace(/\r/g, '').trim(),
    summary: flat(j.summary) || extractive(j.explanation, 3),
    sections,
    key_points: (j.key_points || []).filter(k => k && k.point).slice(0, 5).map(k => ({ point: flat(k.point), explanation: flat(k.explanation), page: clamp(k.page) })),
    definitions: (j.definitions || []).filter(d => d && d.term && d.meaning).slice(0, 5).map(d => ({ term: flat(d.term), meaning: flat(d.meaning), page: clamp(d.page) })),
    failed: false, chunks: chunks.length, at: Date.now()
  };
}

async function summariseModule({ groq, mod, units, onWait }) {
  const digest = units.map(u => `Unit ${u.n} (${u.title}, pages ${u.pages}): ${u.summary}`).join('\n');
  const user = `SUMMARIES OF THE UNITS IN MODULE ${mod.n}:\n${digest.slice(0, 12000)}\n\nReturn ONLY JSON: {"title":"short theme title for the module (max 8 words)","overview":"150-220 words summarising the whole module: what it covers, what each unit contributes, and how the units connect"}\nUse only the summaries above.`;
  let j = null; try { j = await jsonCall(groq, user, 900, onWait); } catch { j = null; }
  j = j || {};
  return { title: flat(j.title), overview: flat(j.overview) || units.map(u => u.summary).join(' ').slice(0, 700), at: Date.now() };
}

/* ------------------------------------------------------------ one or many courses, together */
async function runBatch({ groq, items, regenerate, emit, aborted = () => false }) {
  // items: [{ m, store, scope? }]
  const jobs = [], perCourse = new Map();
  items.forEach(it => {
    const { row, outline } = it.m;
    let mods = outline.modules;
    if (it.scope && it.scope.module) mods = mods.filter(x => x.n === +it.scope.module).map(x => it.scope.unit ? { ...x, units: x.units.filter(u => u.n === +it.scope.unit) } : x);
    const total = mods.reduce((a, x) => a + x.units.length, 0);
    perCourse.set(row.id, { id: row.id, title: row.title, total, done: 0, failed: [], mods });
    emit({ type: 'step', key: 'outline-' + row.id, title: `Reading the structure of ${row.title}`, done: true,
      desc: outline.structured ? `I found ${outline.modules.length} modules and ${outline.modules.reduce((a, x) => a + x.units.length, 0)} units.${(outline.warnings && outline.warnings.length) ? ' Note: ' + outline.warnings.join(' ') : ''}` : `This PDF has no Module/Unit headings, so I split it into ${total} parts by page range.` });
    mods.forEach(mod => mod.units.forEach(unit => {
      const key = `${mod.n}.${unit.n}`; const old = it.store.units[key];
      if (!old || regenerate || old.failed) jobs.push({ it, mod, unit, key, id: row.id });
      else perCourse.get(row.id).done++;
    }));
  });
  // interleave so every course moves forward together
  const byCourse = items.map(it => jobs.filter(j => j.id === it.m.row.id)); const queue = [];
  for (let i = 0; byCourse.some(a => i < a.length); i++) byCourse.forEach(a => { if (a[i]) queue.push(a[i]); });

  const grand = () => ({ done: [...perCourse.values()].reduce((a, c) => a + c.done, 0), total: [...perCourse.values()].reduce((a, c) => a + c.total, 0) });
  const progress = live => { const g = grand(); emit({ type: 'progress', done: g.done, total: g.total, courses: [...perCourse.values()].map(c => ({ material_id: c.id, title: c.title, done: c.done, total: c.total, failed: c.failed.length })) });
    emit({ type: 'step', key: 'units', title: items.length > 1 ? `Summarising ${items.length} courses together` : `Summarising ${items[0].m.row.title}`, done: false, desc: 'Reading every page of every unit, then writing a full explanation for each.', live: `${g.done} of ${g.total} units done${live ? '  -  ' + live : ''}` }); };
  progress('starting');

  let fatal = null, lastWait = 0;
  async function pass(list) {
    const failed = []; let idx = 0;
    async function worker() {
      while (idx < list.length && !fatal && !aborted()) {
        const job = list[idx++]; const c = perCourse.get(job.id);
        const tag = `${c.title.length > 22 ? c.title.slice(0, 22) + '…' : c.title} - Module ${job.mod.n} Unit ${job.unit.n}`;
        progress(tag);
        try {
          const u = await summariseUnit({ groq, m: job.it.m, mod: job.mod, unit: job.unit, onWait: (sec, rate) => { lastWait = sec; emit({ type: 'step', key: 'wait', title: 'Waiting for AI capacity', done: false, desc: `The AI is limited to a number of requests per minute. Continuing in ${sec}s...`, live: `${tag}` }); } });
          job.it.store.units[job.key] = u; await job.it.store.save(); c.done++; c.failed = c.failed.filter(k => k !== job.key);
          emit({ type: 'unit', material_id: job.id, key: job.key, unit: u }); progress(tag);
        } catch (e) {
          if (e instanceof AI.AIError && ['auth', 'model', 'config'].includes(e.kind)) { fatal = e; return; }
          job.err = e; failed.push(job); if (!c.failed.includes(job.key)) c.failed.push(job.key);
          console.error(`[summary] ${tag} failed: ${AI.friendly(e)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, list.length) }, worker));
    return failed;
  }

  let failed = await pass(queue);
  for (let round = 1; round <= 3 && failed.length && !fatal && !aborted(); round++) {     // wait out rate limits, then retry only what failed
    const wait = Math.min(60, Math.max(8, ...failed.map(j => (j.err && j.err.waitSec) || 0)));
    emit({ type: 'step', key: 'wait', title: 'Waiting for AI capacity', done: false, desc: `${failed.length} unit(s) are waiting for AI capacity. Retrying in ${wait}s (attempt ${round + 1} of 4)...`, live: '' });
    await new Promise(r => setTimeout(r, wait * 1000));
    failed = await pass(failed);
  }
  if (fatal) { const e = fatal; throw e; }

  // module overviews (one short call each, in parallel)
  const mjobs = [];
  items.forEach(it => { const c = perCourse.get(it.m.row.id); if (!it.m.outline.structured) return;
    c.mods.forEach(mod => { const us = mod.units.map(u => it.store.units[`${mod.n}.${u.n}`]).filter(u => u && !u.failed); const mo = it.store.modules[mod.n];
      if (us.length && (regenerate || !mo || !mo.overview || us.length === mod.units.length && !mo.complete)) mjobs.push({ it, mod, us, complete: us.length === mod.units.length }); }); });
  emit({ type: 'step', key: 'units', title: 'Summarising', done: true, desc: 'All units written. Now writing the module overviews.' });
  if (mjobs.length) {
    emit({ type: 'step', key: 'modules', title: 'Writing each module overview', done: false, desc: 'Combining the unit explanations into one overview per module.', live: '' });
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(POOL, mjobs.length) }, async () => { while (k < mjobs.length) { const j = mjobs[k++]; const mo = await summariseModule({ groq, mod: j.mod, units: j.us }); mo.complete = j.complete; j.it.store.modules[j.mod.n] = mo; await j.it.store.save(); emit({ type: 'module', material_id: j.it.m.row.id, n: j.mod.n, module: mo }); } }));
    emit({ type: 'step', key: 'modules', title: 'Writing each module overview', done: true, desc: 'Module overviews are ready.' });
  }
  return items.map(it => { const c = perCourse.get(it.m.row.id); return { material_id: c.id, title: c.title, total: c.total, done: c.done, failed: c.failed, reasons: failed.filter(j => j.id === c.id).map(j => ({ key: j.key, reason: AI.friendly(j.err) })) }; });
}

module.exports = { runBatch, summariseUnit, summariseModule, unitChunks, parseLoose };
