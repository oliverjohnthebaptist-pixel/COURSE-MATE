// Detects the NOUN course structure: Module N -> Unit N: Title -> sections (3.1, 3.2 ...) from the real PDF pages.
const lines = t => String(t || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
const isTitleLike = s => /^[A-Z0-9(“"'‘]/.test(s);

const UNIT_RE = /^unit\s*(\d{1,2})\s*[`'’:.\-–—)]*\s*(.*)$/i;
const MODULE_RE = /^module\s*(\d{1,2})\s*[`'’:.\-–—)]*\s*(.*)$/i;
const SECTION_RE = /^(\d{1,2})\.(\d{1,2})\s+([A-Z].{2,95})$/;

function cleanTitle(s) {
  return String(s || '').replace(/\bCONTENTS\b.*$/i, '').replace(/[\s,;:.\-–]+$/, '').replace(/\s+\d{1,3}$/, '')
    .replace(/\s+/g, ' ').trim();
}
function titleCase(s) {
  if (!s || s !== s.toUpperCase() || s.length < 4) return s;
  return s.toLowerCase().replace(/(^|[\s(\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(And|Of|In|The|To|For|On|At|By|Or|A|An)\b(?!$)/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());
}

function buildOutline(pages) {
  const N = pages.length;
  const L = pages.map(lines);
  const unitHeads = []; const moduleMarks = [];
  L.forEach((ls, pi) => {
    const modsOnPage = ls.filter(l => MODULE_RE.test(l) && l.length < 60).length;
    ls.forEach((l, li) => {
      let m;
      if (modsOnPage < 2 && (m = MODULE_RE.exec(l)) && l.length < 70) {
        const rest = cleanTitle(m[2]);
        moduleMarks.push({ page: pi + 1, n: +m[1], title: /^unit\b/i.test(rest) || /^\d+$/.test(rest) ? '' : rest });
      }
      if ((m = UNIT_RE.exec(l)) && l.length < 120) {
        const title = cleanTitle(m[2]);
        if (title && !isTitleLike(title)) return;
        // a real unit heading is followed (within a few lines) by CONTENTS / 1.0 Introduction / Objectives
        const next = ls.slice(li + 1, li + 9).concat(li + 9 > ls.length && L[pi + 1] ? L[pi + 1].slice(0, 6) : []);
        const nextJoin = next.join(' | ');
        const followed = /\bcontents\b|^1\.0\s*intro|\bintroduction\b|\bobjectives\b|^1\.0/i.test(nextJoin) || /\bcontents\b/i.test(l);
        if (!followed) return;
        // a "Unit N" heading must not itself be followed directly by another Unit line (that is a list)
        if (next.length && UNIT_RE.test(next[0])) return;
        let t = title;
        if (!t) { const cand = next.find(x => x && !/^\d/.test(x) && !/^contents$/i.test(x)); t = cleanTitle(cand || ''); }
        else {
          let extra = 0, cur = t;
          while (extra < 2) {
            const nl = ls[li + 1 + extra];
            if (!nl || /^contents\b/i.test(nl) || /^\d/.test(nl) || nl.length > 70 || UNIT_RE.test(nl) || MODULE_RE.test(nl)) break;
            const connector = /\b(and|of|in|the|to|for|on|at|by|or|a|an|between|with|through|from)$/i.test(cur);
            const caps = title === title.toUpperCase() && nl === nl.toUpperCase();
            if (!(connector || caps)) break;
            cur = cleanTitle(cur + ' ' + nl); extra++;
          }
          t = cur;
        }
        unitHeads.push({ page: pi + 1, n: +m[1], title: titleCase(t) });
      }
    });
  });

  // keep one heading per (page, number); keep the chain in page order
  const seen = new Set(); const heads = [];
  unitHeads.sort((a, b) => a.page - b.page).forEach(h => { const k = h.page + ':' + h.n; if (!seen.has(k)) { seen.add(k); heads.push(h); } });

  // assign modules: module marker with the greatest page <= unit page; if none, use the reset of unit numbers
  const mods = new Map();
  let curMod = 0, lastN = 0;
  const units = [];
  heads.forEach(h => {
    const mm = moduleMarks.filter(m => m.page <= h.page).sort((a, b) => b.page - a.page || b.n - a.n)[0];
    let mod;
    if (mm) mod = mm.n; else { if (h.n <= lastN) curMod++; if (!curMod) curMod = 1; mod = curMod; }
    lastN = h.n; curMod = mod;
    units.push({ module: mod, n: h.n, title: h.title, start: h.page });
  });
  // drop duplicates of the same (module, unit) - keep the later heading (the real one, not a list)
  const uniq = new Map(); units.forEach(u => { uniq.set(u.module + ':' + u.n, u); });
  let list = [...uniq.values()].sort((a, b) => a.start - b.start || a.n - b.n);
  // two "units" starting on the same page: the extra one is a contents-list artefact - keep the lowest number
  list = list.filter((u, i) => !list.some((o, j) => j !== i && o.start === u.start && (o.n < u.n || (o.n === u.n && j < i))));

  // a module whose Unit 1 heading was not recognised: use the page after the module marker
  const modsSeen = [...new Set(list.map(u => u.module))];
  modsSeen.forEach(mn => {
    const us = list.filter(u => u.module === mn).sort((a, b) => a.start - b.start);
    const mark = moduleMarks.filter(m => m.n === mn).sort((a, b) => b.page - a.page)[0];
    if (!us.length || us[0].n <= 1 || !mark || us[0].start - mark.page < 3) return;
    const listTitle = (L[mark.page - 1].map(l => UNIT_RE.exec(l)).filter(Boolean).find(m => +m[1] === 1) || [])[2];
    list.push({ module: mn, n: 1, title: titleCase(cleanTitle(listTitle || '')) || 'Unit 1', start: mark.page });
  });
  list.sort((a, b) => a.start - b.start || a.n - b.n);
  list.forEach((u, i) => {
    u.end = i + 1 < list.length ? Math.max(u.start, list[i + 1].start - 1) : N;
    const bound = moduleMarks.filter(m => m.n !== u.module && m.page > u.start && m.page <= u.end && !list.some(o => o.start === m.page)).sort((a, b) => a.page - b.page)[0];
    if (bound) u.end = Math.max(u.start, bound.page - 1);
  });

  // sections inside each unit (numbered headings such as 3.1, 3.2)
  list.forEach(u => {
    const found = new Map();
    for (let p = u.start; p <= u.end; p++) L[p - 1].forEach((l, li) => {
      const m = SECTION_RE.exec(l); if (!m) return;
      const num = m[1] + '.' + m[2];
      if (m[2] === '0' ) return;                          // 3.0 Main Content etc. are not sections
      const title = cleanTitle(m[3]); if (title.length < 3 || /^\d/.test(title)) return;
      found.set(num, { num, title: titleCase(title), page: p, line: li });   // later (body) heading overwrites the contents-list one
    });
    u.sections = [...found.values()].sort((a, b) => a.page - b.page || a.line - b.line);
  });

  const modNums = [...new Set(list.map(u => u.module))].sort((a, b) => a - b);
  const modules = modNums.map(n => {
    const us = list.filter(u => u.module === n);
    const mark = moduleMarks.filter(m => m.n === n && m.title).sort((a, b) => b.page - a.page)[0];
    return { n, title: mark ? titleCase(mark.title) : '', start: us[0].start, end: us[us.length - 1].end, units: us.map(({ module, ...rest }) => rest) };
  });
  return { structured: modules.length > 0 && list.length >= 2, modules, pages: N };
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
module.exports = { buildOutline, sectionText, textOf };
