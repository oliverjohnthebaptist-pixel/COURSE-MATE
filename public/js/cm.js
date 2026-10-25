// Shared helpers for Summary, Quiz, Chat and Settings pages (inline styles only - the CSS files are not touched).
window.CM = (function () {
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cleanTitle = t => String(t || '').replace(/\s+-\s+\d+\s+pages?$/i, '');

  async function materials(sel, onChange) {
    try {
      const d = await (await fetch('/api/materials')).json();
      if (!d.materials || !d.materials.length) { sel.innerHTML = '<option value="">No material - go upload in the Materials page</option>'; return []; }
      sel.innerHTML = d.materials.map(m => `<option value="${esc(m.id)}">${esc(m.title)} - ${m.page_count || 0} pages</option>`).join('');
      const saved = localStorage.getItem('selected_material'); if (saved && d.materials.some(m => m.id === saved)) sel.value = saved;
      sel.onchange = () => { localStorage.setItem('selected_material', sel.value); onChange && onChange(); };
      onChange && onChange();
      return d.materials;
    } catch { sel.innerHTML = '<option value="">Failed to load materials</option>'; return []; }
  }

  async function waitJob(id, onEvent) {
    let after = 0, doneEvent = null;
    while (true) {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}?after=${after}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Could not check task status (${response.status}).`);
      for (const event of data.events || []) {
        if (event.type === 'error') throw new Error(event.error || 'The task could not be completed.');
        if (event.type === 'done') { doneEvent = event; continue; }
        if (event.type !== 'ping' && onEvent) onEvent(event);
      }
      after = Number(data.after) || after;
      if (data.status === 'failed') throw new Error(data.error || 'The task could not be completed.');
      if (data.status === 'completed') {
        if (doneEvent) return doneEvent;
        throw new Error('The task ended without returning a result. Please try again.');
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }

  // POST JSON and read a stream of JSON lines or poll a queued background task.
  async function stream(url, body, onEvent) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ('Server error ' + r.status)); }
    // A queued background task: the server answers with plain JSON holding a job id (status 200 or 202).
    const ctype = r.headers.get('content-type') || '';
    if (r.status === 202 || /application\/json/i.test(ctype)) {
      const queued = await r.json().catch(() => ({}));
      const jobId = queued.job_id || queued.jobId || queued.id;
      if (!jobId) throw new Error('The server accepted the task but did not return its task ID.');
      return waitJob(jobId, onEvent);
    }
    if (!r.body) throw new Error('The server returned an empty response. Please try again.');
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', done = null;
    while (true) {
      const { value, done: fin } = await reader.read(); if (fin) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'error') throw new Error(ev.error);
        if (ev.type === 'done') done = ev; else if (ev.type !== 'ping' && onEvent) onEvent(ev);
      }
    }
    if (!done) throw new Error('The server stopped before finishing. Please try again.');
    return done;
  }

  // Steps / Sources panel (same look as the TMA page)
  let pid = 0; const panels = {};
  function panel(el, opts) {
    opts = opts || {}; const id = 'p' + (++pid);
    const st = { steps: [], sources: [], tab: 'steps', finished: false, pill: opts.pill || 'Working from your PDF' };
    function render() {
      const dot = d => d
        ? '<span style="position:absolute;left:-8px;top:1px;width:15px;height:15px;border-radius:50%;background:#2AF598;color:#08130D;font-size:10px;font-weight:800;display:grid;place-items:center">✓</span>'
        : '<span style="position:absolute;left:-5px;top:5px;width:9px;height:9px;border-radius:50%;background:#8BA89A"></span>';
      const rows = st.steps.map(s => `
        <div style="position:relative;padding:0 0 18px 18px;border-left:1px solid #1C3324;margin-left:6px">${dot(s.done)}
          <div style="font-size:13px;font-weight:700;color:#E8F5EC">${esc(s.title)}</div>
          <div style="font-size:12px;color:#8BA89A;line-height:1.6;margin-top:3px">${esc(s.desc)}</div>
          ${s.live && !s.done ? `<div style="font-size:11px;color:#2AF598;margin-top:5px">${esc(s.live)}</div>` : ''}
        </div>`).join('');
      const done = `<div style="position:relative;padding:0 0 0 18px;margin-left:6px">
        <span style="position:absolute;left:-8px;top:0;width:15px;height:15px;border-radius:50%;border:1px solid ${st.finished ? '#2AF598' : '#1C3324'};color:${st.finished ? '#2AF598' : '#3d5646'};font-size:10px;display:grid;place-items:center">✓</span>
        <div style="font-size:13px;font-weight:700;color:${st.finished ? '#E8F5EC' : '#5d7a69'}">Done</div></div>`;
      const src = st.sources.length ? st.sources.map(s => `
        <div style="border:1px solid #1C3324;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#08130D">
          <div style="font-size:12px;font-weight:700;color:#E8F5EC">${esc(s.page)}${s.refs ? ` <span style="font-weight:400;color:#7A9A85">- ${esc(s.refs)}</span>` : ''}</div>
          <div style="font-size:11px;color:#8BA89A;font-style:italic;line-height:1.55;margin-top:4px">"${esc(s.snippet)}"</div></div>`).join('')
        : '<div style="font-size:12px;color:#7A9A85;padding:6px 2px">Sources will appear here as pages are used.</div>';
      const tab = (t, l) => `<button onclick="CM.tab('${id}','${t}')" style="flex:1;border:none;cursor:pointer;padding:9px 10px;border-radius:20px;font-size:12px;font-weight:700;background:${st.tab === t ? '#1C3324' : 'transparent'};color:${st.tab === t ? '#E8F5EC' : '#7A9A85'}">${l}</button>`;
      el.innerHTML = `${st.finished ? '' : `<div style="display:inline-block;background:#111F18;border:1px solid #1C3324;border-radius:20px;padding:6px 14px;font-size:12px;font-weight:700;color:#E8F5EC;margin-bottom:12px">${esc(st.pill)}</div>`}
        <div style="background:#0B1A12;border:1px solid #1C3324;border-radius:14px;padding:12px;margin-bottom:16px">
          <div style="display:flex;gap:4px;background:#08130D;border-radius:22px;padding:3px;margin-bottom:14px">${tab('steps', 'Steps')}${tab('sources', 'Sources')}</div>
          ${st.tab === 'steps' ? rows + done : src}</div>`;
    }
    const api = {
      event(ev) {
        if (ev.type === 'step') {
          let s = st.steps.find(x => x.key === ev.key); if (!s) { s = { key: ev.key }; st.steps.push(s); }
          if (ev.title != null) s.title = ev.title; if (ev.desc != null) s.desc = ev.desc; s.live = ev.live; s.done = !!ev.done;
        } else if (ev.type === 'source') {
          const hit = st.sources.find(x => x.page === ev.page);
          if (hit) { if (ev.refs && !hit.refs.includes(ev.refs)) hit.refs = hit.refs ? hit.refs + ', ' + ev.refs : ev.refs; }
          else st.sources.push({ page: ev.page, snippet: ev.snippet, refs: ev.refs || '' });
        } else return;
        render();
      },
      finish() { st.finished = true; st.steps.forEach(s => s.done = true); render(); },
      clear() { el.innerHTML = ''; }, render
    };
    panels[id] = { st, render }; render(); return api;
  }
  function tab(id, t) { const p = panels[id]; if (p) { p.st.tab = t; p.render(); } }

  // Small, safe markdown: **bold**, *italic*, bullets, numbered lists, paragraphs, (P.56) chips
  function md(text) {
    const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b style="color:#fff">$1</b>').replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<code style="background:#08130D;padding:1px 5px;border-radius:5px">$1</code>')
      .replace(/\((~?P\.\d+(?:\s*[,&-]\s*(?:P\.)?\d+)*)\)/gi, '<span style="font-size:10px;font-weight:700;color:#2AF598;background:rgba(42,245,152,.1);border:1px solid rgba(42,245,152,.25);border-radius:10px;padding:1px 7px">$1</span>');
    const out = []; let list = null;
    const flush = () => { if (list) { out.push(`<${list.t} style="margin:6px 0 10px 20px;padding:0">${list.items.map(i => `<li style="margin-bottom:4px">${i}</li>`).join('')}</${list.t}>`); list = null; } };
    String(text || '').split('\n').forEach(line => {
      const b = /^\s*[-*•]\s+(.*)/.exec(line), n = /^\s*\d+[.)]\s+(.*)/.exec(line);
      if (b) { if (!list || list.t !== 'ul') { flush(); list = { t: 'ul', items: [] }; } list.items.push(inline(b[1])); }
      else if (n) { if (!list || list.t !== 'ol') { flush(); list = { t: 'ol', items: [] }; } list.items.push(inline(n[1])); }
      else if (!line.trim()) flush();
      else { flush(); const h = /^#{1,4}\s+(.*)/.exec(line); out.push(h ? `<div style="font-weight:800;color:#fff;margin:10px 0 4px">${inline(h[1])}</div>` : `<p style="margin:0 0 8px">${inline(line)}</p>`); }
    });
    flush(); return out.join('');
  }

  const DEF = { quizCount: 20, quizLevel: 'mixed', chatGeneral: false };
  const prefs = () => { let p = {}; try { p = JSON.parse(localStorage.getItem('cm_prefs') || '{}'); } catch {} p = Object.assign({}, DEF, p); if (!(p.quizCount >= 20)) p.quizCount = 20; if (!['mixed', 'easy', 'medium', 'hard'].includes(p.quizLevel)) p.quizLevel = 'mixed'; return p; };

  // "Upload PDF" button used on every feature page (same endpoint as the Materials page)
  function uploader(slot, opts) {
    opts = opts || {};
    slot.innerHTML = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px">
      <button type="button" class="cm-up-btn" style="background:transparent;border:1px solid #2AF598;color:#2AF598;padding:9px 16px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer">⬆ Upload PDF</button>
      <span class="cm-up-status" style="font-size:11px;color:#7A9A85">PDF only - once uploaded it is available in every feature.</span></div>
      <input type="file" class="cm-up-file" accept=".pdf,application/pdf" style="display:none">`;
    const btn = slot.querySelector('.cm-up-btn'), input = slot.querySelector('.cm-up-file'), st = slot.querySelector('.cm-up-status');
    btn.onclick = () => input.click();
    input.onchange = async () => {
      const f = input.files[0]; if (!f) return;
      if (!/\.pdf$/i.test(f.name)) { st.style.color = '#ff6b6b'; st.textContent = 'Please choose a PDF file.'; input.value = ''; return; }
      btn.disabled = true; btn.style.opacity = '.6'; st.style.color = '#2AF598'; st.textContent = `Uploading "${f.name}" and reading every page...`;
      try {
        const r = await window.cmUploadPdf(f); const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || 'Upload failed');
        localStorage.setItem('selected_material', d.id);
        if (opts.reload) await opts.reload(d);
        st.style.color = d.material?.scanned ? '#ffb347' : '#2AF598';
        st.textContent = d.material?.scanned
          ? `⚠ ${d.title} uploaded and selected, but appears scanned/image-only. OCR is not available; searchable text is needed.`
          : `✓ ${d.title} uploaded (${d.pages} pages) and selected.`;
      } catch (e) { st.style.color = '#ff6b6b'; st.textContent = 'Upload failed: ' + e.message; }
      btn.disabled = false; btn.style.opacity = '1'; input.value = '';
    };
  }
  const chip = (label, on, click) => `<button onclick="${click}" style="cursor:pointer;padding:8px 14px;border-radius:20px;font-size:12px;font-weight:700;border:1px solid ${on ? '#2AF598' : '#1C3324'};background:${on ? '#2AF598' : '#111F18'};color:${on ? '#05210F' : '#8BA89A'}">${label}</button>`;
  const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  // Shows the REAL logged-in student's name and initial in the top bar (replaces the fixed "Oliver" / "O").
  async function personalise() {
    try {
      const bar = document.querySelector('.topbar');
      if (!bar) return;
      const r = await fetch('/api/me');
      if (!r.ok) return;
      const d = await r.json();
      const u = (d && d.user) || {};
      const full = String(u.name || '').trim() || String(u.email || '').split('@')[0] || '';
      if (!full) return;
      const first = full.split(/\s+/)[0];
      const right = bar.querySelector(':scope > div:last-child');
      if (!right) return;
      const nameEl = right.querySelector('b');
      if (nameEl) nameEl.textContent = first;
      const avatar = right.querySelector(':scope > div:last-child');
      if (avatar && avatar !== nameEl && !avatar.querySelector('b')) avatar.textContent = first.charAt(0).toUpperCase();
    } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', personalise);
  else personalise();

  return { esc, cleanTitle, materials, stream, waitJob, panel, tab, md, prefs, chip, fmtDate, uploader };
})();