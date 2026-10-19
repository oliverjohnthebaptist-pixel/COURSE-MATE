// Summary (per Module / Unit / Section), Quiz (20+ mixed-level random questions), AI Tutor, stats.
// Every answer is built ONLY from the uploaded PDF (real page numbers).
const fs = require('fs');
const path = require('path');
const E = require('./tma_engine');
const O = require('./outline');
const AI = require('./ai');
const SE = require('./summary_engine');

const STORAGE_ROOT = process.env.COURSEMATE_STORAGE_DIR ? path.resolve(process.env.COURSEMATE_STORAGE_DIR) : null;
const DATA_DIR = STORAGE_ROOT ? path.join(STORAGE_ROOT, 'data') : path.join(__dirname, 'data');
if (!process.env.SUPABASE_SERVICE_KEY) fs.mkdirSync(DATA_DIR, { recursive: true });
const SUM_FILE = path.join(DATA_DIR, 'summaries.json');
const migrateLegacyFile = (name, destination) => {
  const legacy = path.join(__dirname, name);
  if (!fs.existsSync(destination) && fs.existsSync(legacy)) fs.copyFileSync(legacy, destination);
};
if (!process.env.SUPABASE_SERVICE_KEY) migrateLegacyFile('summaries.json', SUM_FILE);
const rd = (f, d) => {
  if (!fs.existsSync(f)) return d;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`Persistent store ${f} contains invalid JSON: ${e.message}`); }
};
const wr = (f, d) => {
  const tmp = `${f}.${process.pid}.${require('crypto').randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, f);
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const { flat, norm, tokens } = E;

function ndjson(res) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders && res.flushHeaders();
  return o => { try { res.write(JSON.stringify(o) + '\n'); } catch {} };
}
const shortText = (s, n) => (s.length > n ? s.slice(0, n - 1).trim() + '…' : s);
const plabel = (n, approx) => (approx ? '~P.' : 'P.') + n;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ------------------------------------------------------------ material + structure */
// Many PDFs repeat the same title line on every page. Remove it so it never pollutes prompts, quotes or search.
function findHeader(pages) {
  const N = pages.length; if (N < 6) return '';
  const words = pages.map(t => String(t).split(/\s+/).filter(Boolean));
  const counts = new Map();
  words.forEach(w => { if (w.length >= 6) { const k = w.slice(0, 6).join(' '); counts.set(k, (counts.get(k) || 0) + 1); } });
  let best = null, bc = 0; counts.forEach((c, k) => { if (c > bc) { bc = c; best = k; } });
  if (!best || bc < Math.max(4, N * 0.25)) return '';
  const group = words.filter(w => w.length >= 6 && w.slice(0, 6).join(' ') === best);
  let len = 6; while (group.every(w => w.length > len && w[len] === group[0][len])) len++;
  return group[0].slice(0, len).join(' ');
}
const cache = new Map();
async function loadMaterial(rows, id) {
  const row = rows.find(x => x.id === id);
  if (!row) return null;
  let pending = cache.get(row.id);
  if (!pending) {
    pending = (async () => {
      const raw = await E.getPages(row);
      const head = findHeader(raw.pages);
      const n = head ? head.split(' ').length : 0;
      const pages = raw.pages.map(t => { if (!head) return t; const w = String(t).split(/\s+/).filter(Boolean); return w.slice(0, n).join(' ') === head ? w.slice(n).join(' ') : t; });
      let outline = O.buildOutline(raw.pages);
      if (!outline.structured) {                       // no Module/Unit markers: split into parts so the feature still works
        const N = raw.pages.length, k = Math.max(1, Math.min(8, Math.ceil(raw.pages.join('').length / 14000))), per = Math.ceil(N / k), units = [];
        for (let i = 0; i < N; i += per) units.push({ n: units.length + 1, title: `Pages ${i + 1}-${Math.min(N, i + per)}`, start: i + 1, end: Math.min(N, i + per), sections: [] });
        outline = { structured: false, modules: [{ n: 1, title: '', start: 1, end: N, units }], pages: N };
      }
      const info = { pages, approx: raw.approx };
      return { head, info, outline, raw: raw.pages, idx: E.buildIndex(row.id + ':clean', info) };
    })();
    cache.set(row.id, pending);
  }
  try {
    return { row, ...(await pending) };
  } catch (error) {
    if (cache.get(row.id) === pending) cache.delete(row.id);
    throw error;
  }
}
const whereIs = (outline, page) => {
  if (!outline.structured) return '';
  for (const m of outline.modules) for (const u of m.units) if (page >= u.start && page <= u.end) return `Module ${m.n} Unit ${u.n}`;
  return '';
};
const findUnit = (outline, mn, un) => { const m = outline.modules.find(x => x.n === +mn); return m ? { m, u: m.units.find(x => x.n === +un) } : {}; };

// the text of a unit, balanced across its sections (or pages), as a prompt block
function unitMaterial(m, unit, budget = 11000) {
  const strip = t => { t = String(t).replace(/\s+/g, ' '); return (m.head ? t.split(m.head).join(' ') : t).replace(/\s+/g, ' ').trim(); };
  const blocks = [];
  if (unit.sections && unit.sections.length >= 2) {
    const per = Math.max(500, Math.floor(budget / unit.sections.length));
    unit.sections.forEach((s, i) => {
      const parts = O.sectionText(m.raw, unit, i);
      const text = strip(parts.map(p => p.text).join(' '));
      const last = parts.length ? parts[parts.length - 1].page : s.page;
      blocks.push(`[SECTION ${s.num} ${s.title} | pages ${s.page}-${last}]\n${text.slice(0, per)}`);
    });
  } else {
    const n = unit.end - unit.start + 1, each = Math.max(400, Math.floor(budget / Math.max(1, n)));
    for (let p = unit.start; p <= unit.end; p++) { const t = strip(m.raw[p - 1] || ''); if (t.length > 40) blocks.push(`[PAGE ${p}]\n${t.slice(0, each)}`); }
  }
  return blocks.join('\n\n');
}

/* ------------------------------------------------------------ SUMMARY (per module / unit / section) */
const SUM_SYS = 'You summarise course material using ONLY the text provided. Never add outside facts. Write clearly for a university student. Output one JSON object and nothing else.';

async function summariseUnit({ groq, m, mod, unit }) {
  const hasSec = unit.sections && unit.sections.length >= 2;
  const body = unitMaterial(m, unit);
  const secList = hasSec ? unit.sections.map(s => `${s.num} ${s.title}`).join('; ') : '';
  const user = `COURSE MATERIAL - Module ${mod.n} Unit ${unit.n}: ${unit.title} (pages ${unit.start}-${unit.end}):\n${body}\n\n` +
    `Return ONLY JSON:\n{"summary":"90-130 words summarising this whole unit","explanation":"280-380 words that EXPLAIN this unit expressly, like a good lecturer teaching it to a student who has not read it: what it is about, how each main idea works, why it matters, and one simple example taken from the text. Write 3-4 short paragraphs separated by a blank line.","sections":[{"num":"${hasSec ? '3.1' : ''}","title":"","summary":"3-4 sentences explaining what this section teaches","page":<page number>}],"key_points":[{"point":"one sentence","explanation":"1-2 sentences","page":<page number>}],"definitions":[{"term":"","meaning":"","page":<page number>}]}\n` +
    (hasSec ? `Give exactly one entry in "sections" for each of these sections, in order: ${secList}.\n` : `In "sections" list 3-5 main ideas of the unit (leave "num" empty, give a short "title" for each idea).\n`) +
    `Give 4-5 key_points and up to 5 definitions (only terms the text actually defines). Use simple words. Do not skip any section.`;
  let j = null;
  try { j = E.parseJSON(await E.callModel(groq, SUM_SYS, user, 3800)); } catch { j = null; }
  const clamp = pg => { pg = parseInt(pg, 10); return pg >= unit.start && pg <= unit.end ? pg : unit.start; };
  j = j || {};
  let sections;
  if (hasSec) {
    const byNum = new Map((j.sections || []).map(s => [String(s.num || '').trim(), s]));
    sections = unit.sections.map((s, i) => { const r = byNum.get(s.num) || (j.sections || [])[i] || {}; return { num: s.num, title: s.title, summary: flat(r.summary), page: s.page }; });
  } else sections = (j.sections || []).filter(s => s && (s.title || s.summary)).slice(0, 5).map(s => ({ num: '', title: flat(s.title), summary: flat(s.summary), page: clamp(s.page) }));
  return {
    n: unit.n, title: unit.title, pages: `${unit.start}-${unit.end}`, start: unit.start, end: unit.end,
    explanation: String(j.explanation || '').replace(/\r/g, '').trim(),
    summary: flat(j.summary) || (j.summary === undefined ? 'The AI could not summarise this unit - click Regenerate to try again.' : ''),
    sections,
    key_points: (j.key_points || []).filter(k => k && k.point).slice(0, 5).map(k => ({ point: flat(k.point), explanation: flat(k.explanation), page: clamp(k.page) })),
    definitions: (j.definitions || []).filter(d => d && d.term && d.meaning).slice(0, 5).map(d => ({ term: flat(d.term), meaning: flat(d.meaning), page: clamp(d.page) })),
    failed: !j.summary, at: Date.now()
  };
}
async function summariseModule({ groq, mod, unitResults }) {
  const digest = unitResults.map(u => `Unit ${u.n} (${u.title}, pages ${u.pages}): ${u.summary}`).join('\n');
  const user = `SUMMARIES OF THE UNITS IN MODULE ${mod.n}:\n${digest.slice(0, 12000)}\n\nReturn ONLY JSON: {"title":"short theme title for the module (max 8 words)","overview":"150-220 words summarising the whole module: what it covers, what each unit contributes, and how the units connect"}\nUse only the summaries above.`;
  let j = null; try { j = E.parseJSON(await E.callModel(groq, SUM_SYS, user, 700)); } catch { j = null; }
  j = j || {};
  return { title: flat(j.title), overview: flat(j.overview) || unitResults.map(u => u.summary).join(' ').slice(0, 600), at: Date.now() };
}

async function runSummary({ groq, m, scope, regenerate, emit, store }) {
  const { row, outline, info } = m;
  let mods = outline.modules;
  if (scope && scope.module) mods = mods.filter(x => x.n === +scope.module);
  if (scope && scope.module && scope.unit) mods = mods.map(x => ({ ...x, units: x.units.filter(u => u.n === +scope.unit) }));
  const nUnits = mods.reduce((a, x) => a + x.units.length, 0);
  if (!nUnits) throw new Error('That module/unit was not found in this material.');
  const label = outline.structured ? 'module' : 'part';
  emit({ type: 'step', key: 'outline', title: `Reading the structure of ${row.title}`, done: true,
    desc: outline.structured
      ? `I found ${outline.modules.length} modules and ${outline.modules.reduce((a, x) => a + x.units.length, 0)} units in the PDF. I'll summarise ${scope && scope.module ? (scope.unit ? `Module ${scope.module} Unit ${scope.unit}` : `Module ${scope.module}`) : 'every module'} unit by unit, section by section.`
      : `This PDF has no Module/Unit headings, so I split it into ${nUnits} parts by page range.` });

  const result = { modules: [] };
  let done = 0;
  for (const mod of mods) {
    const unitResults = [];
    for (const unit of mod.units) {
      const key = `${mod.n}.${unit.n}`;
      let u = store.units[key];
      const tag = outline.structured ? `Module ${mod.n} Unit ${unit.n}` : `Part ${unit.n}`;
      if (!u || regenerate) {
        emit({ type: 'step', key: 'units', title: `Summarising ${row.title} unit by unit`, done: false,
          desc: `I'm reading each unit, then writing a summary for every section with the page where it appears.`, live: `${tag}: ${unit.title} (pages ${unit.start}-${unit.end})  -  ${done + 1} of ${nUnits}` });
        u = await summariseUnit({ groq, m, mod, unit });
        if (!u.failed) { store.units[key] = u; store.save(); }
        const pg = m.raw[unit.start - 1];
        if (pg) emit({ type: 'source', page: plabel(unit.start, info.approx), snippet: shortText(flat(m.info.pages[unit.start - 1] || pg), 200), refs: tag });
      }
      done++; unitResults.push(u);
    }
    let mo = store.modules[mod.n];
    if (outline.structured && (!mo || regenerate || !mo.overview || scope && scope.unit)) {
      if (!(scope && scope.unit) && unitResults.length) {
        emit({ type: 'step', key: 'modules', title: 'Writing each module overview', done: false, desc: 'I\'m combining the unit summaries into one overview per module.', live: `Module ${mod.n}` });
        mo = await summariseModule({ groq, mod, unitResults }); store.modules[mod.n] = mo; store.save();
      }
    }
    result.modules.push({ n: mod.n, title: mod.title || (mo && mo.title) || '', overview: (mo && mo.overview) || '', units: unitResults });
  }
  emit({ type: 'step', key: 'units', title: `Summarising ${row.title} unit by unit`, done: true, desc: `Finished ${nUnits} ${nUnits === 1 ? 'unit' : 'units'}, with page references you can check in the PDF.` });
  if (result.modules.some(x => x.overview)) emit({ type: 'step', key: 'modules', title: 'Writing each module overview', done: true, desc: 'Module overviews are ready.' });
  return result;
}

/* ------------------------------------------------------------ QUIZ */
const DIFF = {
  easy: 'EASY = test direct recall of a fact, term or definition that is stated in the passage.',
  medium: 'MEDIUM = test understanding of an idea stated in the passage (why/how/which best describes), with plausible wrong options.',
  hard: 'HARD = test careful understanding; the wrong options must be very plausible and close to the right one, so the student must know the passage well.'
};
const QUIZ_SYS = 'You write exam questions using ONLY the passage provided. The correct answer must be stated in the passage. Never use outside knowledge. Output one JSON object and nothing else.';

function goodPage(p) {
  const t = p.text; if (t.length < 700) return false;
  if ((t.match(/\.{5,}/g) || []).length > 3) return false;
  if ((t.match(/\d/g) || []).length / t.length > 0.12) return false;
  if (/\b(references?\s*\/?\s*further readings?|table of contents|tutor-marked assignment)\b/i.test(t.slice(0, 160))) return false;
  return (E.sentences(t) || []).length >= 5;
}
function randomWindow(page, max = 1600) {
  const ss = E.sentences(page.text); if (!ss.length) return flat(page.text).slice(0, max);
  const start = Math.floor(Math.random() * Math.max(1, ss.length - 4));
  let out = '';
  for (let i = start; i < ss.length && (out + ss[i]).length < max; i++) out += (out ? ' ' : '') + ss[i];
  return out || ss.slice(start).join(' ').slice(0, max);
}
// random pages spread over the WHOLE document (one random pick from each equal slice)
function pickPages(idx, count, topic) {
  let pool = idx.pages.filter(goodPage);
  if (!pool.length) pool = idx.pages.filter(p => p.text.length > 300);
  if (topic) {
    const tk = [...new Set(tokens(topic))];
    const scored = pool.map(p => ({ p, s: tk.reduce((a, t) => a + (p.tf.get(t) ? 1 + Math.log(1 + p.tf.get(t)) : 0), 0) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length) pool = scored.slice(0, Math.max(count * 2, 12)).map(x => x.p).sort((a, b) => a.n - b.n);
  }
  if (!pool.length) return [];
  const k = Math.min(count, pool.length), step = pool.length / k, chosen = [];
  for (let i = 0; i < k; i++) { const lo = Math.floor(i * step), hi = Math.max(lo + 1, Math.floor((i + 1) * step)); chosen.push(pool[lo + Math.floor(Math.random() * (hi - lo))]); }
  while (chosen.length < count) chosen.push(pool[Math.floor(Math.random() * pool.length)]);
  return chosen;
}
function levelPlan(n, level) {
  if (level !== 'mixed') return Array(n).fill(level);
  const e = Math.round(n * 0.35), h = Math.round(n * 0.25), a = [];
  for (let i = 0; i < n; i++) a.push(i < e ? 'easy' : i < e + h ? 'hard' : 'medium');
  return shuffle(a);
}
function buildQuestion(raw, page, level, approx, outline) {
  const q = flat(raw.question), correct = flat(raw.correct);
  const wrong = [...new Set((raw.wrong || []).map(flat).filter(w => w && w.toLowerCase() !== correct.toLowerCase()))].slice(0, 3);
  if (q.length < 12 || !correct || wrong.length < 3) return null;
  let evidence = flat(raw.evidence), verified = false;
  const en = norm(evidence);
  if (en.length >= 15 && (' ' + page.norm + ' ').includes(' ' + en + ' ')) verified = true;
  else { const bs = E.bestSentence([page], [...tokens(correct), ...tokens(q)]); if (!bs) return null; evidence = flat(bs.text); }
  const letters = ['a', 'b', 'c', 'd'], opts = shuffle([correct, ...wrong]), options = {};
  letters.forEach((l, i) => { options[l] = opts[i]; });
  return { id: uid(), question: q, options, answer: letters[opts.indexOf(correct)], explanation: flat(raw.explanation) || 'This is stated in your material.',
    evidence, page: page.n, page_label: plabel(page.n, approx), where: whereIs(outline, page.n), level, verified };
}

async function generateQuiz({ groq, m, count, level, topic, emit }) {
  const { row, idx, info, outline } = m;
  emit({ type: 'step', key: 'pick', title: `Choosing random passages from ${row.title}`, done: false,
    desc: `I'm picking passages at random from across the whole PDF${topic ? ` (focused on "${topic}")` : ''}, so every quiz is different.` });
  const pages = pickPages(idx, Math.ceil(count * 1.4), topic);
  if (!pages.length) throw new Error('This material has no readable text to build a quiz from.');
  const plan0 = levelPlan(pages.length, level);
  const pairs = shuffle(pages.map((p, i) => ({ p, l: plan0[i] })));      // random order, so questions come from everywhere
  pages.splice(0, pages.length, ...pairs.map(x => x.p)); const plan = pairs.map(x => x.l);
  const span = pages.map(x => x.n).sort((a, b) => a - b);
  emit({ type: 'step', key: 'pick', title: `Choosing random passages from ${row.title}`, done: true,
    desc: `Picked ${pages.length} passages spread over pages ${span[0]} to ${span[span.length - 1]}${level === 'mixed' ? ', mixing Easy, Medium and Hard questions' : `, all at ${level} level`}.` });

  const questions = []; let cursor = 0, rounds = 0, aiErr = null;
  while (questions.length < count && rounds < 14) {
    rounds++;
    let batch = pages.slice(cursor, cursor + 5), lv = plan.slice(cursor, cursor + 5); cursor += 5;
    if (!batch.length) { batch = pickPages(idx, 5, topic); lv = levelPlan(5, level); }
    emit({ type: 'step', key: 'write', title: 'Writing and checking questions', done: false,
      desc: 'I\'m writing multiple-choice questions and checking each answer against the page it came from.',
      live: `Questions ${Math.min(count, questions.length + 1)}-${Math.min(count, questions.length + batch.length)} of ${count}` });
    const passages = batch.map((p, k) => `PASSAGE ${k + 1} (page ${p.n}, level: ${lv[k].toUpperCase()}):\n${randomWindow(p)}`).join('\n\n');
    const user = `${passages}\n\nLEVELS:\n${Object.values(DIFF).join('\n')}\nWrite ONE multiple-choice question per passage at the level given for that passage. Rules: the question must make sense on its own (never say "the passage" or "according to the text"); the correct answer must be stated in the passage; give exactly 3 wrong options that are believable but clearly wrong; evidence must be ONE sentence copied word-for-word from the passage.\nReturn ONLY JSON: {"questions":[{"passage":<number>,"question":"","correct":"","wrong":["","",""],"explanation":"1-2 sentences saying why the answer is right","evidence":"exact sentence from the passage"}]}`;
    let j = null;
    try { j = E.parseJSON(await E.callModel(groq, QUIZ_SYS, user, 2400)); } catch (e) { aiErr = e; j = null; if (e && ['auth', 'model', 'config'].includes(e.kind)) break; }
    ((j && j.questions) || []).forEach(raw => {
      const k = (parseInt(raw.passage, 10) || 0) - 1, pg = batch[k]; if (!pg || questions.length >= count) return;
      const q = buildQuestion(raw, pg, lv[k], info.approx, outline);
      if (!q || questions.some(x => norm(x.question) === norm(q.question))) return;
      questions.push(q);
      emit({ type: 'source', page: q.page_label, snippet: shortText(q.evidence, 200), refs: `Q${questions.length}` });
    });
  }
  shuffle(questions);
  const breakdown = { easy: 0, medium: 0, hard: 0 }; questions.forEach(q => breakdown[q.level]++);
  emit({ type: 'step', key: 'write', title: 'Writing and checking questions', done: true,
    desc: questions.length ? `Your quiz is ready: ${questions.length} questions (${breakdown.easy} easy, ${breakdown.medium} medium, ${breakdown.hard} hard), each with an explanation and its page.` : 'I could not build questions from this material.' });
  if (!questions.length) throw (aiErr || new Error('Could not build questions from this material. Try another topic or click Generate again.'));   // show the REAL reason (busy / key) instead of a vague message
  return { id: uid(), material_id: row.id, title: row.title, level, count: questions.length, breakdown, questions };
}

/* ------------------------------------------------------------ AI TUTOR */
const TUTOR_SYS = 'You are CourseMate AI Tutor: a friendly, encouraging, interactive study partner for Nigerian university (NOUN) students. The COURSE MATERIAL EXCERPTS are from the student\'s own PDF: treat them as the main source for anything about the course, and cite pages like (P.56) after those facts. You may also add helpful general knowledge to explain better (extra background, real-life examples, exam tips) but label it "Beyond your PDF:" so the student knows what is NOT from their material. Structure: a short direct answer first, then the explanation in simple steps or bullets, then an example or exam tip. Match the student\'s language: simple English by default; if they write or ask for Nigerian Pidgin, reply in Pidgin. Be warm and conversational, never robotic. ALWAYS finish with ONE short follow-up question that keeps the conversation going.';
const TUTOR_GENERAL = 'You are CourseMate AI Tutor: a smart, friendly, interactive assistant with broad general knowledge, like a good AI chat assistant, built for Nigerian university (NOUN) students. You can talk about anything the student asks: course concepts, maths, writing, computing, exam technique, study planning, current general knowledge, careers, advice, or just a friendly chat. Answer directly and accurately in clear simple English (use Nigerian Pidgin if the student writes or asks for it). Use real, relatable examples (Nigerian where helpful). If the question is about a course topic and the student\'s uploaded PDF did not clearly cover it, start with one short line: "ℹ️ I did not find this in your PDF, so this is from general knowledge." Do not add that line for greetings, casual chat or non-course questions. If you are not sure of a fact, say so instead of guessing. Remember the earlier messages in this conversation and respond to them. Keep answers focused (not an essay unless asked) and end with ONE short question or offer that invites the student to continue.';
const MODE_NOTE = {
  simple: 'The student did not fully understand. Explain the same idea again in VERY simple words, as if to a JSS3 student, with a short everyday analogy labelled "Analogy:". Keep the facts consistent with the excerpts.',
  example: 'Give 1-2 concrete examples that illustrate the idea. Use examples from the excerpts where possible; if you make a simple everyday example, label it "Example:" and keep it consistent with the excerpts.',
  unit: 'Teach this whole unit like a tutor: (1) what it is about in two sentences, (2) the key ideas as bullets with pages, (3) one exam tip. Then ask the student which part they want to go deeper on.'
};

async function streamCompletion(groq, messages, emit, max = 1400, temp = 0.25) {
  await AI.stream(groq, { messages, maxTokens: max, temperature: temp, priority: 0, onToken: t => emit({ type: 'token', text: t }) });
}
async function followUps(groq, ctx, question) {
  try {
    const j = E.parseJSON(await E.callModel(groq, 'Output one JSON object and nothing else.',
      `COURSE EXCERPT:\n${ctx.slice(0, 2500)}\n\nThe student asked: ${question}\nSuggest 3 short follow-up questions (max 12 words each) the student might ask next, each answerable from the excerpt.\nReturn ONLY JSON: {"suggestions":["","",""]}`, 250));
    return ((j && j.suggestions) || []).map(flat).filter(Boolean).slice(0, 3);
  } catch { return []; }
}

async function tutor({ groq, m, b, emit }) {
  const { row, idx, info, outline } = m;
  const mode = ['chat', 'simple', 'example', 'unit', 'quizme', 'grade'].includes(b.mode) ? b.mode : 'chat';
  const message = flat(b.message);
  const history = (Array.isArray(b.history) ? b.history : []).slice(-12).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 1500) }));
  const topic = flat(b.topic || '');
  const P = n => plabel(n, info.approx);

  // ---- explain a whole unit
  if (mode === 'unit') {
    const { m: mod, u } = findUnit(outline, b.module, b.unit);
    if (!u) { emit({ type: 'token', text: 'I could not find that unit in this material.' }); return { covered: false }; }
    emit({ type: 'step', key: 'search', title: `Reading Module ${mod.n} Unit ${u.n}`, done: true, desc: `I'm reading "${u.title}" on pages ${u.start}-${u.end} of ${row.title}.` });
    const ctx = unitMaterial(m, u, 9000);
    emit({ type: 'sources', pages: [`P.${u.start}-${u.end}`] });
    emit({ type: 'source', page: `P.${u.start}-${u.end}`, snippet: shortText(flat(info.pages[u.start - 1] || ''), 200), refs: `Module ${mod.n} Unit ${u.n}` });
    await streamCompletion(groq, [{ role: 'system', content: TUTOR_SYS + '\n' + MODE_NOTE.unit }, { role: 'user', content: `COURSE MATERIAL EXCERPTS (Module ${mod.n} Unit ${u.n}: ${u.title}):\n${ctx}\n\nPlease teach me this unit.` }], emit, 1500);
    emit({ type: 'suggestions', items: [`Quiz me on Unit ${u.n}`, `Explain the hardest part of Unit ${u.n} simply`, 'Give me an example'] });
    return { covered: true, topic: `Module ${mod.n} Unit ${u.n}: ${u.title}` };
  }

  // ---- quiz me: the tutor asks the student a question from the material
  if (mode === 'quizme') {
    emit({ type: 'step', key: 'search', title: 'Choosing a question for you', done: false, desc: topic ? `I'm looking in your PDF for something about: ${shortText(topic, 80)}` : 'I\'m picking a random page from your PDF.' });
    let pages;
    if (topic) { const f = E.searchPages(idx, topic, []); pages = f.top.map(x => x.page); }
    if (!pages || !pages.length) pages = pickPages(idx, 1, '');
    const pg = pages[0]; if (!pg) { emit({ type: 'token', text: 'I could not find a good page to ask about.' }); return { covered: false }; }
    const ctx = E.pageWindow(pg, tokens(topic), 1800);
    const j = E.parseJSON(await E.callModel(groq, 'Output one JSON object and nothing else.', `COURSE EXCERPT (page ${pg.n}):\n${ctx}\n\nWrite ONE short-answer question (not multiple choice) that tests understanding of an idea stated in the excerpt. It must make sense on its own.\nReturn ONLY JSON: {"question":""}`, 200)) || {};
    const q = flat(j.question);
    if (!q) { emit({ type: 'token', text: 'Let me try again - please press **Quiz me** once more.' }); return { covered: false }; }
    emit({ type: 'step', key: 'search', title: 'Choosing a question for you', done: true, desc: `Question taken from ${P(pg.n)}.` });
    emit({ type: 'token', text: `Let's test what you know! 🎯\n\n**${q}**\n\nType your answer below. Don't worry about being perfect - I'll help you improve it.` });
    emit({ type: 'challenge', question: q, pages: [pg.n] });
    return { covered: true };
  }

  // ---- grade the student's answer to the pending question
  if (mode === 'grade') {
    const ch = b.challenge || {};
    const pgs = (ch.pages || []).map(n => idx.pages.find(p => p.n === +n)).filter(Boolean);
    const f = E.searchPages(idx, `${ch.question} ${message}`, []);
    const all = [...pgs, ...f.top.map(x => x.page)].filter((p, i, a) => a.findIndex(q => q.n === p.n) === i).slice(0, 3);
    emit({ type: 'step', key: 'search', title: 'Checking your answer against the PDF', done: true, desc: `I'm comparing your answer with ${all.map(p => P(p.n)).join(', ')}.` });
    all.forEach(p => emit({ type: 'source', page: P(p.n), snippet: shortText(E.pageWindow(p, tokens(ch.question || ''), 220), 200), refs: 'Your answer' }));
    emit({ type: 'sources', pages: all.map(p => P(p.n)) });
    const ctx = all.map(p => `[PAGE ${p.n}]\n${E.pageWindow(p, tokens(ch.question || ''), 2000)}`).join('\n\n');
    await streamCompletion(groq, [{ role: 'system', content: TUTOR_SYS + '\nNow you are MARKING the student\'s answer. Begin with exactly one of: "✅ Correct!", "🟡 Partly right.", or "❌ Not quite." Then say what they got right, what is missing or wrong, and give the complete correct answer with page citations. Be kind and encouraging. End by offering the next question.' },
      { role: 'user', content: `COURSE MATERIAL EXCERPTS:\n${ctx}\n\nQUESTION I WAS ASKED: ${ch.question}\nMY ANSWER: ${message}` }], emit, 1000);
    emit({ type: 'suggestions', items: ['Ask me another question', 'Explain that more simply', 'Give me an example'] });
    return { covered: true };
  }

  // ---- normal chat / simpler / example
  const prevUser = [...history].reverse().find(h => h.role === 'user');
  const base = topic || (message.split(/\s+/).length < 7 && prevUser ? `${prevUser.content} ${message}` : message);
  emit({ type: 'step', key: 'search', title: `Searching ${row.title}`, done: false, desc: `I'm searching the uploaded PDF for: ${shortText(base, 90)}` });
  const found = E.searchPages(idx, base, []);
  const covered = found.top.length && found.coverage >= 0.4 && found.absentShare < 0.5;
  emit({ type: 'step', key: 'search', title: `Searching ${row.title}`, done: true,
    desc: covered ? `Found relevant text on ${found.top.map(x => P(x.page.n)).join(', ')}${whereIs(outline, found.top[0].page.n) ? ` (${whereIs(outline, found.top[0].page.n)})` : ''}.` : 'I did not find a section that clearly covers this.' });
  let system, user, ctx = '';
  if (covered) {
    const qt = tokens(base);
    ctx = found.top.map(x => `[PAGE ${info.approx ? '~' : ''}${x.page.n}]\n${E.pageWindow(x.page, qt, 2200)}`).join('\n\n').slice(0, 7500);
    found.top.forEach(x => emit({ type: 'source', page: P(x.page.n), snippet: shortText(E.pageWindow(x.page, qt, 220), 200), refs: whereIs(outline, x.page.n) }));
    emit({ type: 'sources', pages: found.top.map(x => P(x.page.n)) });
    system = TUTOR_SYS + (MODE_NOTE[mode] ? '\n' + MODE_NOTE[mode] : '');
    user = `COURSE MATERIAL EXCERPTS:\n${ctx}\n\nSTUDENT ${mode === 'chat' ? 'QUESTION' : 'REQUEST'}: ${message}`;
  } else { system = TUTOR_GENERAL; user = message; }  // always answer: general knowledge like other AI assistants
  emit({ type: 'step', key: 'answer', title: 'Writing the answer', done: false, desc: covered ? 'I\'m explaining this using the pages found above.' : 'This is not clearly in your PDF, so I\'m answering from general knowledge.' });
  await streamCompletion(groq, [{ role: 'system', content: system }, ...history, { role: 'user', content: user }], emit, covered ? 1400 : 1200, covered ? 0.35 : 0.6);
  emit({ type: 'step', key: 'answer', title: 'Writing the answer', done: true, desc: 'Answer complete.' });
  if (covered) { const s = await followUps(groq, ctx, message); if (s.length) emit({ type: 'suggestions', items: s }); }
  return { covered, topic: base };
}

/* ------------------------------------------------------------ routes */
function register(app, { groq, loadMaterials, loadHistory, loadSummary, saveSummary, jobs, userId, countUsage, ensureAllowance }) {
  const jsonErr = (res, code, msg) => res.status(code).json({ error: msg });
  const fail = (res, sent, e) => { console.error(e); const msg = AI.friendly(e); if (sent) { try { res.write(JSON.stringify({ type: 'error', error: msg, kind: e && e.kind, waitSec: e && e.waitSec }) + '\n'); res.end(); } catch {} } else res.status(e && e.kind === 'rate' ? 429 : 500).json({ error: msg, kind: e && e.kind }); };
  const storeFor = async id => {
    const all = loadSummary ? await loadSummary(id) : rd(SUM_FILE, {})[id];
    let e = all;
    if (!e || e.v !== 4) e = { v: 4, units: {}, modules: {} };
    return {
      units: e.units, modules: e.modules,
      async save() {
        const payload = { v: 4, units: this.units, modules: this.modules };
        if (saveSummary) return saveSummary(id, payload);
        const a = rd(SUM_FILE, {}); a[id] = payload; wr(SUM_FILE, a);
      }
    };
  };

  app.get('/api/outline/:id', async (req, res) => {
    try { const m = await loadMaterial(loadMaterials(), req.params.id); if (!m) return jsonErr(res, 404, 'Material not found');
      res.json({ structured: m.outline.structured, pages: m.outline.pages, title: m.row.title, warnings: m.outline.warnings || [],
        modules: m.outline.modules.map(x => ({ n: x.n, title: x.title, start: x.start, end: x.end, units: x.units.map(u => ({ n: u.n, title: u.title, start: u.start, end: u.end, approx: !!u.approx, sections: u.sections.map(s => ({ num: s.num, title: s.title, page: s.page })) })) })) });
    } catch (e) { jsonErr(res, 500, e.message); }
  });
  app.get('/api/summary/:id', async (req, res) => { const s = await storeFor(req.params.id); res.json({ units: s.units, modules: s.modules }); });
  const resultFor = (it) => ({ modules: it.m.outline.modules.map(mod => ({ n: mod.n, title: mod.title || (it.store.modules[mod.n] && it.store.modules[mod.n].title) || '', overview: (it.store.modules[mod.n] && it.store.modules[mod.n].overview) || '', units: mod.units.map(u => it.store.units[`${mod.n}.${u.n}`]).filter(Boolean) })) });
  async function summaryRun(payload, emit) {
    const ids = [payload.material_id];
    const scope = payload.scope || {};
    if (!ids.length || !ids[0]) throw new Error('Select a course material first.');
    emit({ type: 'step', key: 'prepare', title: 'Preparing your course material', done: false, desc: 'Loading your PDF and finding its modules and units.' });
    const items = [];
    for (const id of ids) {
      const m = await loadMaterial(loadMaterials(), id);
      if (!m) throw new Error('Course material not found. Return to Materials and select one of your uploaded PDFs.');
      items.push({ m, store: await storeFor(id), scope });
    }
    const courses = await SE.runBatch({ groq, items, regenerate: !!payload.regenerate, emit, aborted: () => false });
    const stores = {}; items.forEach(it => { stores[it.m.row.id] = { units: it.store.units, modules: it.store.modules }; });
    const first = items[0];
    emit({ type: 'done', courses, stores, result: resultFor(first), units: first.store.units, modules: first.store.modules });
  }
  jobs.register('summary', summaryRun);

  async function quizJob(payload, emit) {
    await ensureAllowance('quiz');
    const count = Math.min(60, Math.max(20, parseInt(payload.count, 10) || 20));
    const level = ['mixed', 'easy', 'medium', 'hard'].includes(payload.level || payload.difficulty) ? (payload.level || payload.difficulty) : 'mixed';
    const m = await loadMaterial(loadMaterials(), payload.material_id);
    if (!m) throw new Error('Go to Materials and upload a PDF first');
    const quiz = await generateQuiz({ groq, m, count, level, topic: flat(payload.topic).slice(0, 120), emit });
    await countUsage('quiz');
    emit({ type: 'done', quiz });
  }
  jobs.register('quiz', quizJob);
  app.get('/api/tutor/intro/:id', async (req, res) => {
    try { const m = await loadMaterial(loadMaterials(), req.params.id); if (!m) return jsonErr(res, 404, 'Material not found');
      res.json({ title: m.row.title, pages: m.outline.pages, structured: m.outline.structured,
        modules: m.outline.modules.map(x => ({ n: x.n, title: x.title, units: x.units.map(u => ({ n: u.n, title: u.title })) })) });
    } catch (e) { jsonErr(res, 500, e.message); }
  });
  async function tutorJob(payload, emit) {
    const message = flat(payload.message).slice(0, 1500);
    if (!message && !['unit', 'quizme'].includes(payload.mode)) throw new Error('Type a question first');
    if (!['unit', 'quizme'].includes(payload.mode)) await ensureAllowance('chat');
    const rows = loadMaterials();
    if (!rows.some(row => row.id === payload.material_id)) throw new Error('Go to Materials and upload a PDF first');
    emit({ type: 'step', key: 'load', title: 'Preparing your course material', done: false, desc: 'I’m loading the PDF text for your tutor request.' });
    const m = await loadMaterial(rows, payload.material_id);
    emit({ type: 'step', key: 'load', title: 'Preparing your course material', done: true, desc: 'Your PDF is ready. I’m working on your question.' });
    const result = await tutor({ groq, m, b: { ...payload, message }, emit });
    if (!['unit', 'quizme'].includes(payload.mode)) await countUsage('chat');
    emit({ type: 'done', covered: result.covered, topic: result.topic || '' });
  }
  jobs.register('tutor', tutorJob);

  const queueJob = type => async (req, res, next) => {
    try {
      const id = await jobs.enqueue(userId(), type, req.body || {});
      res.status(202).json({ job_id: id });
    } catch (error) { next(error); }
  };
  app.post('/api/summary', queueJob('summary'));
  app.post('/api/quiz/generate', queueJob('quiz'));
  app.post('/api/tutor', queueJob('tutor'));
  app.post('/api/chat', queueJob('tutor'));

}
module.exports = { register };
