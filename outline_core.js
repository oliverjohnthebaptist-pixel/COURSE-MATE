// Outline v2 - finds EVERY module and unit of a NOUN course PDF.
// Idea: the table of contents / course guide lists the real structure (e.g. 5 modules x 4 units).
// We read that list first, then locate each listed unit's real starting page in the body, in order.
// A unit that is listed is never silently dropped.
const stem = w => w.length > 4 ? w.replace(/(ing|ies|ed|es|s)$/, '') : w;
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|with|from|that|this|are|was)$/.test(w)).map(stem);
const sim = (a, b) => { const A = new Set(words(a)), B = new Set(words(b)); if (!A.size || !B.size) return 0; let i = 0; A.forEach(x => { if (B.has(x)) i++; }); return i / Math.min(A.size, B.size); };

const UNIT_RE = /^unit\s*(\d{1,2})\s*[`'’:.\-–—)]*\s*(.*)$/i;
const MODULE_RE = /^module\s*(\d{1,2})\s*[`'’:.\-–—)]*\s*(.*)$/i;
const SECTION_RE = /^(\d{1,2})\.(\d{1,2})\s+([A-Z].{2,95})$/;
const FOLLOW_RE = /^(table of )?contents:?$|^contents\b|^1\.0\b|^2\.0\s*objectives\b|^objectives:?$/i;   // line-START patterns only

function cleanTitle(s) {
  return String(s || '').replace(/\.{3,}.*$/, '').replace(/\bCONTENTS\b.*$/i, '').replace(/[\s,;:.\-–]+$/, '').replace(/\s+\d{1,3}$/, '').replace(/\s+/g, ' ').trim();
}
function titleCase(s) {
  if (!s || s !== s.toUpperCase() || s.length < 4) return s;
  return s.toLowerCase().replace(/(^|[\s(\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(And|Of|In|The|To|For|On|At|By|Or|A|An)\b(?!$)/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());
}
const titleish = t => !t || (/^[A-Z0-9(“"'‘]/.test(t) && t.split(/\s+/).length <= 18 && !/[a-z]{2,}\.\s*$/.test(t) && !/\b(this unit|this module|you will|we will|is a|are the)\b/i.test(t));
const isCaps = t => t.length > 3 && t === t.toUpperCase();

// non-empty, whitespace-normalised lines with broken headings repaired ("UNIT" / "1:" on two lines)
function pageLines(text) {
  const raw = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    if (/^(unit|module)$/i.test(l) && raw[i + 1] && /^\d{1,2}\b/.test(raw[i + 1])) { l = l + ' ' + raw[i + 1]; i++; }
    out.push(l);
  }
  return out;
}

function scan(pages) {
  const N = pages.length;
  const L = pages.map(pageLines);
  const heads = [];
  L.forEach((ls, pi) => {
    ls.forEach((l, li) => {
      let m, kind;
      if ((m = UNIT_RE.exec(l)) && l.length < 130) kind = 'unit';
      else if ((m = MODULE_RE.exec(l)) && l.length < 130) kind = 'module';
      else return;
      let title = cleanTitle(m[2]);
      // title on the following line(s)?  (heading is only "UNIT 3:" or the title wraps)
      let k = 1;
      while (k <= 2) {
        const nl = ls[li + k];
        if (!nl || UNIT_RE.test(nl) || MODULE_RE.test(nl) || /^contents\b|^table of contents/i.test(nl) || /^\d/.test(nl) || nl.length > 80) break;
        const connector = /\b(and|of|in|the|to|for|on|at|by|or|a|an|between|with|through|from|-)$/i.test(title);
        const caps = title && isCaps(title) && isCaps(nl);
        if (!title || connector || caps) { title = cleanTitle((title + ' ' + nl).trim()); k++; } else break;
      }
      if (title && !titleish(title)) return;                       // a sentence, not a heading
      if (kind === 'unit' && !title) return;
      heads.push({ page: pi + 1, line: li, kind, n: +m[1], title, caps: isCaps(title) });
    });
  });
  // is the heading a real body heading? A real unit start is (a) followed by "Table of contents / 1.0 Introduction / Objectives",
  // (b) not packed together with other headings (that is a list), and (c) has at least ~1 page of text before the next heading
  // (a table of contents lists every unit's section titles but has very little text between headings).
  const cum = [0]; L.forEach((ls, i) => cum.push(cum[i] + ls.reduce((a, x) => a + x.length + 1, 0)));
  const off = h => cum[h.page - 1] + L[h.page - 1].slice(0, h.line).reduce((a, x) => a + x.length + 1, 0);
  const sorted = heads.slice().sort((a, b) => a.page - b.page || a.line - b.line);
  sorted.forEach((h, i) => { const nx = sorted[i + 1]; h.span = nx ? off(nx) - off(h) : cum[N] - off(h); });
  heads.forEach(h => {
    const ls = L[h.page - 1];
    const nxt = ls.slice(h.line + 1, h.line + 7).concat(h.line + 7 > ls.length && L[h.page] ? L[h.page].slice(0, 5) : []);
    const adjacent = nxt.slice(0, 3).some(x => UNIT_RE.test(x) || MODULE_RE.test(x));
    h.followed = h.kind === 'unit' && !adjacent && nxt.some(x => FOLLOW_RE.test(x)) && h.span >= 1800;
    h.pageNo = (/\.{2,}\s*(\d{1,3})\s*$/.exec(ls[h.line]) || [])[1];
  });
  return { L, heads };
}

function buildOutline(pages) {
  const N = pages.length;
  const { L, heads } = scan(pages);
  const byPos = (x, y) => x.page - y.page || x.line - y.line;

  /* ---- 1. real unit starts = body headings, in page order ---- */
  const body = heads.filter(h => h.kind === 'unit' && h.followed).sort(byPos);
  const kept = [];
  body.forEach(h => {            // (a "Unit 5" seen before any "Unit 1" is a list entry, not a unit start)
    if (!kept.length && h.n > 1) return;
    // some PDFs contain the same course text twice: keep the first copy of each unit
    if (!kept.some(k => k.n === h.n && sim(k.title, h.title) >= 0.6 && Math.abs(k.page - h.page) > 3)) kept.push(h);
  });
  const modHeads = heads.filter(h => h.kind === 'module').sort(byPos);
  const modTitle = new Map();
  modHeads.forEach(m => { if (m.title && !/^[\d\s.]+$/.test(m.title) && m.title.length > 3 && (!modTitle.get(m.n) || m.title.length > modTitle.get(m.n).length)) modTitle.set(m.n, m.title); });

  /* ---- 2. give every unit its module: the nearby "MODULE n" heading, else unit-number restart (… 4, 5, 1 …) ---- */
  let units = [], mod = 0, lastN = 0;
  kept.forEach(h => {
    const mh = modHeads.filter(m => (m.page === h.page && m.line < h.line) || (m.page < h.page && m.page >= h.page - 2)).sort((x, y) => byPos(y, x))[0];
    if (mh && mh.n !== mod) mod = mh.n;
    else if (!mod) mod = 1;
    else if (h.n <= lastN && !(mh && mh.n === mod)) mod = mod + 1;
    lastN = h.n;
    units.push({ module: mod, n: h.n, title: titleCase(h.title), start: h.page });
  });

  /* ---- 3. gaps (1, 2, 4 ...): a heading the strict test rejected may still be the missing unit ---- */
  const relaxed = heads.filter(h => h.kind === 'unit');
  const inOrder = () => units.sort((a, b) => a.start - b.start);
  new Set(units.map(u => u.module)).forEach(m => {
    const mine = inOrder().filter(u => u.module === m); const max = Math.max(...mine.map(u => u.n));
    for (let n = 1; n < max; n++) {
      if (mine.some(u => u.n === n)) continue;
      const prev = mine.filter(u => u.n < n).pop(), next = mine.find(u => u.n > n);
      const from = prev ? prev.start + 1 : (next ? Math.max(1, next.start - 40) : 1), to = next ? next.start - 1 : N;
      const c = relaxed.filter(h => h.n === n && h.page >= from && h.page <= to && h.span >= 600).sort((x, y) => (y.caps - x.caps) || byPos(x, y))[0];
      if (c) units.push({ module: m, n, title: titleCase(c.title), start: c.page, approx: true });
    }
  });
  const uniq = new Map(); units.forEach(u => { const k = u.module + ':' + u.n; if (!uniq.has(k)) uniq.set(k, u); });
  let list = [...uniq.values()].sort((a, b) => a.start - b.start || a.module - b.module || a.n - b.n);
  list = list.filter((u, i) => !list.some((o, j) => j < i && o.start === u.start));   // two units cannot start on one page

  /* ---- 3. page ranges ---- */
  const modHeadPages = heads.filter(h => h.kind === 'module' && !h.followed).map(h => ({ page: h.page, n: h.n }));
  list.forEach((u, i) => {
    u.end = i + 1 < list.length ? Math.max(u.start, list[i + 1].start - 1) : N;
    const bound = modHeadPages.filter(m => m.n !== u.module && m.page > u.start && m.page <= u.end && !list.some(o => o.start === m.page)).sort((a, b) => a.page - b.page)[0];
    if (bound) u.end = Math.max(u.start, bound.page - 1);
  });

  /* ---- 4. sections (3.1, 3.2 ...) inside each unit ---- */
  list.forEach(u => {
    const found = new Map();
    for (let p = u.start; p <= u.end; p++) L[p - 1].forEach((l, li) => {
      const m = SECTION_RE.exec(l); if (!m || m[2] === '0') return;
      const num = m[1] + '.' + m[2]; const title = cleanTitle(m[3]); if (title.length < 3 || /^\d/.test(title)) return;
      found.set(num, { num, title: titleCase(title), page: p, line: li });
    });
    u.sections = [...found.values()].sort((a, b) => a.page - b.page || a.line - b.line);
  });

  const modNums = [...new Set(list.map(u => u.module))].sort((a, b) => a - b);
  const modules = modNums.map(n => {
    const us = list.filter(u => u.module === n).sort((a, b) => a.n - b.n);
    return { n, title: titleCase(modTitle.get(n) || ''), start: us[0].start, end: us[us.length - 1].end, units: us.map(({ module, ...rest }) => rest) };
  });
  // the course guide often says "a course consisting of 15 units" - use it to check we found everything
  let expected = 0;
  for (let p = 0; p < Math.min(30, N) && !expected; p++) { const m = /consisting of\s+(\d{1,2})\s+units?/i.exec(L[p].join(' ')); if (m) expected = +m[1]; }
  const found = modules.reduce((a, m) => a + m.units.length, 0);
  const warnings = [];
  if (expected && found < expected) warnings.push(`The course guide says ${expected} units but ${found} were found in the PDF text.`);
  modules.forEach(m => { const nums = m.units.map(u => u.n); for (let i = 1; i < Math.max(...nums); i++) if (!nums.includes(i)) warnings.push(`Module ${m.n}: Unit ${i} was not found in the PDF text.`); });
  return { structured: modules.length > 0 && list.length >= 2, modules, pages: N, expectedUnits: expected || found, foundUnits: found, warnings };
}

// text of a unit or section, page by page (keeps real page numbers)
function textOf(pages, from, to) {
  const out = []; for (let p = from; p <= to && p <= pages.length; p++) out.push({ page: p, text: pages[p - 1] });
  return out;
}
function sectionText(pages, unit, si) {
  const secs = unit.sections, s = secs[si], nx = secs[si + 1];
  const endPage = nx ? nx.page : unit.end;
  const parts = [];
  for (let p = s.page; p <= endPage; p++) {
    let ls = String(pages[p - 1] || '').split('\n');
    let a = 0, b = ls.length;
    if (p === s.page) { const i = ls.findIndex(l => SECTION_RE.test(l.replace(/\s+/g, ' ').trim()) && l.replace(/\s+/g, ' ').trim().startsWith(s.num + ' ')); a = i >= 0 ? i : 0; }
    if (nx && p === nx.page) { const j = ls.findIndex(l => l.replace(/\s+/g, ' ').trim().startsWith(nx.num + ' ')); if (j >= 0) b = Math.max(a + 1, j); }
    const t = ls.slice(a, b).join(' ').replace(/\s+/g, ' ').trim();
    if (t) parts.push({ page: p, text: t });
  }
  return parts;
}
module.exports = { buildOutline, sectionText, textOf, scan };
