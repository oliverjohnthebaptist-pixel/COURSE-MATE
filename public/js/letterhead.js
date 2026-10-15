/* CourseMate PDF letterhead - ONE look for every download (Summary, TMA, Quiz, Tutor).
   Same design as the original summary letterhead: green band 28mm + red stripe 1.6mm + logo circle
   + dark footer with page numbers. Needs jsPDF (window.jspdf) loaded on the page. */
window.CMPDF = (function () {
  const GREEN = [11, 122, 66], RED = [200, 32, 36], INK = [30, 30, 30], GREY = [95, 105, 100];
  const W = 210, H = 297, M = 14, TW = W - 2 * M, BOTTOM = 276;

  // jsPDF built-in fonts only know Latin text: swap/strip anything else so the PDF never shows garbage
  const safe = t => String(t == null ? '' : t)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2022/g, '-')
    .replace(/\u20A6/g, 'N').replace(/\u2026/g, '...').replace(/\u00A0/g, ' ')
    .replace(/[\u2190-\u21FF]/g, '->').replace(/[^\x09\x0A\x0D\x20-\x7E\u00A1-\u00FF]/g, '');

  function logoData() {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        try {
          const S = 200, c = document.createElement('canvas'); c.width = c.height = S;
          const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, S, S);
          const r = Math.min(S / img.width, S / img.height), w = img.width * r, h = img.height * r;
          x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
          res(c.toDataURL('image/png'));
        } catch { res(null); }
      };
      img.onerror = () => res(null);
      img.src = '/logo.png';
    });
  }

  function student() { // name from the Supabase session already stored by the login page
    try {
      for (const k of Object.keys(localStorage)) {
        if (/^sb-.*-auth-token$/.test(k)) {
          const s = JSON.parse(localStorage.getItem(k) || '{}'); const u = (s.user || (s.currentSession && s.currentSession.user)) || {};
          return (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.email || '';
        }
      }
    } catch {}
    return '';
  }

  async function create(opts) {
    if (!window.jspdf) throw new Error('PDF library did not load. Check your internet and try again.');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const logo = await logoData();
    const headTitle = safe(opts.title || 'Study Document');
    const footLabel = safe(opts.footer || 'CourseMate');
    let y = 40;

    function header() {
      doc.setFillColor(...GREEN); doc.rect(0, 0, W, 28, 'F');
      doc.setFillColor(...RED); doc.rect(0, 28, W, 1.6, 'F');
      const cx = M + 9, cy = 14.2;
      doc.setFillColor(255, 255, 255); doc.circle(cx, cy, 9.2, 'F');
      if (logo) { try { doc.addImage(logo, 'PNG', cx - 8.6, cy - 8.6, 17.2, 17.2); } catch {} }
      const tx = cx + 9.2 + 5;
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.text('CourseMate', tx, 12.6);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.text('NOUN - Your Smart Study Companion', tx, 17.4);
      doc.setFontSize(6.5); doc.text('NATIONAL OPEN UNIVERSITY OF NIGERIA', tx, 21.2);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      const tl = doc.splitTextToSize(headTitle, 88).slice(0, 3);
      tl.forEach((l, i) => doc.text(l, W - M, 14.4 + (i - (tl.length - 1) / 2) * 4.6, { align: 'right' }));
    }
    header();

    const api = {
      doc, get y() { return y; }, set y(v) { y = v; },
      need(h) { if (y + h > BOTTOM) { doc.addPage(); header(); y = 40; } },
      gap(h = 4) { y += h; },
      meta(t) { api.need(6); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...GREY); doc.text(doc.splitTextToSize(safe(t), TW), M, y); y += 5.5; },
      h1(t) { // module banner
        const lines = doc.splitTextToSize(safe(t), TW - 8); const h = lines.length * 6.4 + 5; api.need(h + 6);
        doc.setFillColor(11, 122, 66); doc.roundedRect(M, y, TW, h, 2, 2, 'F');
        doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(lines, M + 4, y + 6.8); y += h + 5;
      },
      h2(t) { const lines = doc.splitTextToSize(safe(t), TW); api.need(lines.length * 6 + 8); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...GREEN); doc.text(lines, M, y); y += lines.length * 6 + 1; doc.setDrawColor(...GREEN); doc.setLineWidth(0.3); doc.line(M, y, W - M, y); y += 5; },
      label(t) { api.need(10); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...GREEN); doc.text(safe(t), M, y); y += 5.5; },
      para(t, o = {}) {
        const size = o.size || 10, lh = size * 0.5, indent = o.indent || 0;
        const st = () => { doc.setFont('helvetica', o.style || 'normal'); doc.setFontSize(size); doc.setTextColor(...(o.color || INK)); };
        st();
        safe(t).split(/\n{2,}/).forEach(p => {
          const lines = doc.splitTextToSize(p.replace(/\s*\n\s*/g, ' ').trim(), TW - indent);
          lines.forEach(l => { api.need(lh + 1); st(); doc.text(l, M + indent, y); y += lh; }); // st() again: a page break resets the colour/font
          y += o.after == null ? 3 : o.after;
        });
      },
      bullet(t, o = {}) {
        const lines = doc.splitTextToSize(safe(t), TW - 8);
        const st = () => { doc.setFont('helvetica', o.style || 'normal'); doc.setFontSize(10); doc.setTextColor(...(o.color || INK)); };
        lines.forEach((l, i) => { api.need(5.5); st(); if (i === 0) doc.text('-', M + 2, y); doc.text(l, M + 7, y); y += 5; }); y += 1.5;
      },
      rule() { if (y + 4 > BOTTOM) return; doc.setDrawColor(210, 220, 214); doc.setLineWidth(0.2); doc.line(M, y, W - M, y); y += 4; },
      save(file) {
        const n = doc.internal.getNumberOfPages();
        for (let p = 1; p <= n; p++) {
          doc.setPage(p); doc.setFillColor(8, 14, 10); doc.rect(0, 282, W, 15, 'F');
          doc.setTextColor(150, 150, 150); doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
          doc.text(`CourseMate | ${footLabel} | Page ${p} of ${n} | NOUN`, W / 2, 290, { align: 'center' });
        }
        doc.save(file); return n;
      }
    };
    return api;
  }

  const stamp = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const fname = s => String(s || 'CourseMate').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
  const who = () => { const n = student(); return n ? `Prepared for ${n}  |  ${stamp()}` : stamp(); };

  /* ---------- SUMMARY: module overview + every unit explained ---------- */
  async function summary({ code, title, modules, saved, modInfo }) {
    const p = await create({ title: `${code} Summary`, footer: `${code} Module-by-Module Summary` });
    p.para(title, { size: 15, style: 'bold', color: [20, 20, 20], after: 1 }); p.meta(who()); p.gap(2);
    let units = 0;
    modules.forEach(m => {
      const mi = (modInfo && modInfo[m.n]) || {};
      p.h1(`Module ${m.n}: ${mi.title || m.title || ''}`.trim());
      if (mi.overview) { p.label('Module overview'); p.para(mi.overview); }
      m.units.forEach(u => {
        const s = saved[`${m.n}.${u.n}`]; if (!s) return; units++;
        p.gap(2); p.h2(`${code} Module ${m.n} Unit ${u.n}: ${s.title || u.title}`);
        p.meta(`Pages ${s.pages || (u.start + '-' + u.end)}`);
        if (s.explanation) { p.label('Explanation'); p.para(s.explanation); }
        else if (s.summary) { p.label('Summary'); p.para(s.summary); }
        if (s.sections && s.sections.some(x => x.summary)) {
          p.label('Section by section');
          s.sections.forEach(x => { if (!x.summary) return; p.para(`${x.num ? x.num + ' ' : ''}${x.title || ''}${x.page ? '  (P.' + x.page + ')' : ''}`, { style: 'bold', after: 0.5 }); p.para(x.summary, { indent: 3, after: 2.5 }); });
        }
        if (s.key_points && s.key_points.length) { p.label('Key points'); s.key_points.forEach(k => p.bullet(`${k.point}${k.explanation ? ' - ' + k.explanation : ''}${k.page ? ' (P.' + k.page + ')' : ''}`)); }
        if (s.definitions && s.definitions.length) { p.label('Definitions'); s.definitions.forEach(d => p.bullet(`${d.term}: ${d.meaning}${d.page ? ' (P.' + d.page + ')' : ''}`)); }
        p.rule();
      });
    });
    if (!units) throw new Error('Nothing to download yet. Create the summary first.');
    return p.save(`${fname(code)}_${fname(title)}_Summary.pdf`);
  }

  /* ---------- TMA: question, quoted PDF evidence + page, answer, options ---------- */
  async function tma({ title, answers }) {
    const code = (String(title).split(/[\s._-]/)[0] || 'TMA').toUpperCase();
    const p = await create({ title: `${code} TMA Answers`, footer: `${code} TMA Solutions` });
    p.para(title, { size: 15, style: 'bold', color: [20, 20, 20], after: 1 }); p.meta(`${answers.length} question${answers.length === 1 ? '' : 's'}  |  ${who()}`);
    const gen = answers.filter(a => a.isGeneral || a.found === false).length;
    if (gen) p.para(`Note: ${gen} answer(s) are marked "General knowledge" because they were not found in the uploaded PDF. Please confirm those with your lecturer before submitting.`, { size: 8.5, style: 'italic', color: [170, 90, 0] });
    p.gap(2);
    answers.forEach((a, i) => {
      p.need(30);
      p.para(`${i + 1}. ${a.question || ''}`, { size: 11, style: 'bold', color: [15, 15, 15], after: 1.5 });
      if (a.evidence && a.found !== false) {
        const pg = a.page ? `P.${a.page}` : 'PDF';
        p.para(`"${a.evidence}"  (${pg})`, { size: 9.5, style: 'italic', color: [70, 80, 75], indent: 3, after: 1.5 });
      }
      p.para(`Answer: ${a.answer || a.answer_text || ''}`, { size: 10.5, style: 'bold', color: GREEN, after: 1 });
      if (a.isGeneral || a.found === false) p.para('Source: General knowledge - NOT from your uploaded PDF.', { size: 8.5, style: 'italic', color: [170, 90, 0], after: 1 });
      else if (a.why) p.para(a.why, { size: 9, color: GREY, after: 1 });
      const o = a.options || {};
      const ol = ['a', 'b', 'c', 'd', 'e'].filter(l => o[l]).map(l => `${l.toUpperCase()}. ${o[l]}`).join('   ');
      if (ol) p.para(`Options: ${ol}`, { size: 9, color: GREY, after: 2 });
      p.rule();
    });
    return p.save(`${fname(code)}_TMA_Answers.pdf`);
  }

  /* ---------- QUIZ: score + every question with the right answer and page proof ---------- */
  async function quiz({ title, questions, picks }) {
    const code = (String(title).split(/[\s._-]/)[0] || 'QUIZ').toUpperCase();
    const n = questions.length, score = questions.filter((q, i) => picks[i] === q.answer).length, pct = Math.round(score / n * 100);
    const p = await create({ title: `${code} Quiz Result`, footer: `${code} Quiz Review` });
    p.para(title, { size: 15, style: 'bold', color: [20, 20, 20], after: 1 }); p.meta(who());
    p.para(`Score: ${score} / ${n}  (${pct}%)`, { size: 13, style: 'bold', color: pct >= 70 ? GREEN : [190, 90, 0], after: 4 });
    questions.forEach((q, i) => {
      const ok = picks[i] === q.answer;
      p.need(32);
      p.para(`${i + 1}. ${q.question}`, { size: 11, style: 'bold', color: [15, 15, 15], after: 1.5 });
      ['a', 'b', 'c', 'd'].forEach(l => { if (q.options && q.options[l]) p.para(`${l.toUpperCase()}. ${q.options[l]}${l === q.answer ? '   [correct]' : ''}${l === picks[i] && !ok ? '   [your answer]' : ''}`, { size: 9.5, color: l === q.answer ? GREEN : GREY, style: l === q.answer ? 'bold' : 'normal', indent: 3, after: 0.5 }); });
      p.para(ok ? 'You got this right.' : `You answered ${picks[i] ? picks[i].toUpperCase() : 'nothing'}. Correct answer: ${String(q.answer).toUpperCase()}.`, { size: 9.5, style: 'bold', color: ok ? GREEN : [190, 50, 50], after: 1 });
      if (q.explanation) p.para(q.explanation, { size: 9.5, after: 1 });
      if (q.evidence) p.para(`"${q.evidence}"  (${q.page_label || 'PDF'})`, { size: 9, style: 'italic', color: GREY, indent: 3, after: 2 });
      p.rule();
    });
    return p.save(`${fname(code)}_Quiz_Result.pdf`);
  }

  /* ---------- TUTOR: the conversation as a study note ---------- */
  async function chat({ title, messages }) {
    const code = (String(title).split(/[\s._-]/)[0] || 'TUTOR').toUpperCase();
    const p = await create({ title: `${code} AI Tutor Notes`, footer: `${code} AI Tutor Session` });
    p.para(title, { size: 15, style: 'bold', color: [20, 20, 20], after: 1 }); p.meta(who()); p.gap(2);
    messages.filter(m => m.content).forEach(m => {
      const you = m.role === 'user'; p.need(14);
      p.label(you ? 'You' : 'AI Tutor');
      p.para(String(m.content).replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[-*]\s+/gm, '- '), { size: 10, color: you ? [20, 60, 120] : INK, after: 3 });
      if (!you && m.pages && m.pages.length) p.para(`Sources: ${m.pages.join(', ')}`, { size: 8.5, style: 'italic', color: GREY, after: 3 });
    });
    return p.save(`${fname(code)}_AI_Tutor_Notes.pdf`);
  }

  return { create, summary, tma, quiz, chat, safe };
})();
