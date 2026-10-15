// CourseMate TMA engine
// Minimal, stable implementation that restores the app's expected API after the original
// engine file was accidentally corrupted with NUL bytes.
const fs = require('fs');
const pdfParse = require('pdf-parse');
const AI = require('./ai');
const OUTLINE = require('./outline');
const cloudStore = require('./supabase-store');

const ENGINE_VERSION = 'CourseMate v2 engine';
const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => flat(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
const STOP_WORDS = new Set('a an and are as at be been being but by can did do does for from had has have he her here him his how i if in into is it its may me my no not of on or our she so than that the their them then there these they this those to was we were what when where which who why will with you your'.split(' '));

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(s => flat(s)).filter(Boolean);
}

function parseJSON(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try { return JSON.parse(candidate); }
  catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (err) {} }
    return null;
  }
}

async function callModel(groq, system, user, maxTokens = 1200, temperature = 0.2) {
  if (!groq) throw new Error('The AI is not configured yet (GROQ_API_KEY is missing).');
  const out = await AI.complete(groq, {
    system: String(system || ''),
    user: String(user || ''),
    maxTokens: Number(maxTokens) || 1200,
    temperature: Number(temperature) || 0.2,
    priority: 1,
    patient: 2
  });
  return String(out || '').trim();
}

async function getPages(row) {
  let buf;
  if (row && row.storage_path) {
    buf = await cloudStore.download('coursemate-files', row.storage_path);
  } else {
    const file = row && row.file_path ? row.file_path : row;
    if (!file || !fs.existsSync(file)) throw new Error('The uploaded PDF could not be found.');
    buf = fs.readFileSync(file);
  }
  const pages = [];
  const data = await pdfParse(buf, {
    pagerender: async pageData => {
      const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY;
      let text = '';
      for (const item of content.items) {
        if (lastY === item.transform[5] || lastY === undefined) text += item.str;
        else text += '\n' + item.str;
        lastY = item.transform[5];
      }
      pages.push(text.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim());
      return text;
    }
  });
  if (pages.length !== data.numrender) throw new Error('Could not extract text from every page of the uploaded PDF.');
  return { pages, approx: false };
}

function buildIndex(id, info) {
  const pages = ((info && info.pages) || []).map((item, i) => {
    const text = String(item && typeof item === 'object' ? item.text || '' : item || '');
    const tf = new Map();
    tokens(text).forEach(token => tf.set(token, (tf.get(token) || 0) + 1));
    return { n: item && typeof item === 'object' && item.n ? item.n : i + 1, text, norm: norm(text), tf };
  });
  return { id, pages, size: pages.length };
}

function searchPages(idx, query, _extra) {
  const q = [...new Set(tokens(query).filter(t => t.length > 1 && !STOP_WORDS.has(t)))];
  if (!idx || !idx.pages || !idx.pages.length || !q.length) {
    return { top: [], coverage: 0, absentShare: 1, approx: false };
  }

  const present = new Set();
  const documentFrequency = new Map();
  q.forEach(token => {
    documentFrequency.set(token, idx.pages.reduce((total, page) => total + (page.tf.has(token) ? 1 : 0), 0));
  });
  const scored = idx.pages.map(page => {
    let score = 0;
    q.forEach(token => {
      const count = page.tf.get(token) || 0;
      if (!count) return;
      present.add(token);
      const df = documentFrequency.get(token) || 0;
      score += (1 + Math.log(count)) * (1 + Math.log((idx.pages.length + 1) / (df + 1)));
    });
    return { page, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.n - b.page.n)
    .slice(0, 8);

  const relevant = new Set();
  scored.slice(0, 3).forEach(item => q.forEach(token => {
    if (item.page.tf.has(token)) relevant.add(token);
  }));
  return {
    top: scored,
    coverage: relevant.size / q.length,
    absentShare: (q.length - present.size) / q.length,
    approx: false
  };
}

function pageWindow(page, queryTokens, cap = 1800) {
  const text = String((page && page.text) || page || '');
  const clean = flat(text);
  const q = Array.isArray(queryTokens) ? queryTokens : tokens(queryTokens || '');
  if (!clean) return '';
  if (!q.length || clean.length <= cap) return clean;

  const lower = clean.toLowerCase();
  const width = Math.max(1, Number(cap) || 1800);
  let bestStart = 0, bestScore = -1;
  q.forEach(word => {
    const at = lower.indexOf(String(word).toLowerCase());
    if (at < 0) return;
    const start = Math.max(0, Math.min(clean.length - width, at - Math.floor(width / 3)));
    const window = lower.slice(start, start + width);
    const score = q.reduce((total, token) => total + (window.includes(String(token).toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) { bestStart = start; bestScore = score; }
  });
  return clean.slice(bestStart, bestStart + width);
}

function bestSentence(pages, keywords) {
  const words = new Set((Array.isArray(keywords) ? keywords : tokens(keywords || '')).map(w => String(w).toLowerCase()));
  let best = null;
  for (const page of pages || []) {
    const list = sentences(page && page.text ? page.text : page || '');
    list.forEach(s => {
      const score = tokens(s).filter(t => words.has(t)).length;
      if (score > (best ? best.score : 0)) {
        best = { score, text: s, page: page && page.n ? page : null };
      }
    });
  }
  return best;
}

function extractTMA(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const questions = [];
  let current = '';

  const flush = () => {
    const q = current.trim();
    if (q && /[?]$|[A-Za-z]/.test(q)) questions.push(q);
    current = '';
  };

  for (const line of lines) {
    const numbered = /^(?:(?:question|q)\s*)?\d{1,3}\s*[.)\-:]\s*(.*)$/i.exec(line);
    const heading = /^(?:question|q)\s*\d+\s*$/i.test(line);
    const option = /^(?:\(?[a-d]\)|[a-d][.)])\s+/i.test(line);
    if (numbered || heading) {
      if (current) flush();
      current = numbered ? numbered[1].trim() : '';
      continue;
    }
    if (option && current) {
      current += (current ? '\n' : '') + line;
      continue;
    }

    if (current && /[?]\s*$/.test(current) && /^(?:what|why|how|when|where|which|who|define|explain|describe|discuss|state|list|outline|compare|differentiate|identify|mention|give|write|calculate|show)\b/i.test(line)) {
      flush();
      current = line;
    } else if (current) {
      current += ' ' + line;
    } else {
      current = line;
    }
  }
  flush();

  const dedup = [];
  const seen = new Set();
  for (const q of questions) {
    const key = norm(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(q);
  }
  return dedup;
}

async function solveTMA({ row, text, groq, emit }) {
  const questions = extractTMA(text);
  if (!questions.length) {
    return { answers: [], mode: 'none', skipped: 0 };
  }

  const material = await getPages(row);
  const pages = material.pages.map((text, i) => ({ n: i + 1, text, norm: norm(text), tf: new Map(tokens(text).map(t => [t, 1])) }));
  if (!pages.some(page => page.text.length >= 40)) {
    throw new Error('This PDF has no readable text. Scanned image-only PDFs are not supported yet.');
  }
  const index = { id: row.id || 'material', pages };

  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (emit) emit({ type: 'step', id: 'search', state: 'active', index: i + 1, text: `Searching your PDF for question ${i + 1} of ${questions.length}...` });
    const match = searchPages(index, q, []);
    const relevant = match.top.slice(0, 4).map(item => item.page);
    if (!relevant.length || match.coverage < 0.2) {
      const result = { question: q, answer: 'The uploaded material does not contain enough information to answer this question.', found: false, why: 'No relevant passage was found in your PDF.' };
      answers.push(result);
      if (emit) emit({ type: 'answer', answer: result });
      continue;
    }
    const context = relevant.map(page => `[PAGE ${page.n}]\n${pageWindow(page, tokens(q), 1500)}`).join('\n\n').slice(0, 5500);
    const prompt = [
      'Answer the TMA question using only the provided course material. Do not guess or add facts absent from it.',
      'If the material does not support an answer, return found=false and explain that briefly.',
      'When the question includes multiple-choice options, select the best option and include its letter and exact option text.',
      'The evidence must be one sentence copied exactly from the supplied material; use its page number.',
      'Return only JSON: {"found":true,"answer":"...","answer_letter":"","options":{},"evidence":"...","page":1,"why":""}',
      `QUESTION:\n${q}`,
      `COURSE MATERIAL:\n${context}`
    ].join('\n\n');

    const raw = await callModel(groq, 'You are a careful academic assistant.', prompt, 800, 0.2);
    const obj = parseJSON(raw);
    if (!obj || !obj.answer) throw new Error('The AI returned an invalid TMA answer. Please try again.');
    let evidence = flat(obj.evidence);
    let source = relevant.find(page => evidence && page.norm.includes(norm(evidence)));
    if (!source) {
      const matchSentence = bestSentence(relevant, [...tokens(q), ...tokens(obj.answer)]);
      if (matchSentence) {
        evidence = flat(matchSentence.text);
        source = matchSentence.page;
      }
    }
    const found = obj.found !== false && !!source;
    const result = {
      question: q,
      answer: found ? flat(obj.answer) : 'The uploaded material does not clearly support an answer to this question.',
      found,
      why: found ? '' : flat(obj.why) || 'No verifiable supporting sentence was found in your PDF.',
      evidence: found ? evidence : '',
      page: found ? source.n : undefined,
      page_label: found ? `P.${source.n}` : '',
      answer_letter: found ? flat(obj.answer_letter) : '',
      options: found && obj.options && typeof obj.options === 'object' ? obj.options : {},
      mode: 'documented'
    };
    answers.push(result);
    if (emit) {
      emit({ type: 'step', id: 'search', state: 'done', index: i + 1, text: `Checked question ${i + 1} of ${questions.length}.` });
      emit({ type: 'answer', answer: result });
    }
  }

  return { answers, mode: 'documented', skipped: 0 };
}

module.exports = {
  ENGINE_VERSION,
  flat,
  norm,
  tokens,
  sentences,
  parseJSON,
  callModel,
  getPages,
  buildIndex,
  searchPages,
  pageWindow,
  bestSentence,
  extractTMA,
  solveTMA,
  outline: OUTLINE
};
