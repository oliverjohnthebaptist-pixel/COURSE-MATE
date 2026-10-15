/* CourseMate: sends the student's login token with every /api call (so the server knows who they are)
   and shows the "Upgrade to Starter" popup when the server says a plan limit was reached (HTTP 402). */
(function () {
  const SB_URL = 'https://lohjifbvrbnqxamroxtp.supabase.co';
  const SB_KEY = 'sb_publishable_-3UptBHer0fKyelp_a3z-g_jfflZF0l';
  const realFetch = window.fetch.bind(window);
  let sbClient = null;

  function stored() {
    try {
      for (const k of Object.keys(localStorage)) {
        if (/^sb-.*-auth-token$/.test(k)) { const s = JSON.parse(localStorage.getItem(k) || 'null'); return (s && s.currentSession) || s; }
      }
    } catch {}
    return null;
  }
  async function token() {
    const s = stored();
    if (s && s.access_token && (!s.expires_at || s.expires_at * 1000 > Date.now() + 30000)) return s.access_token;
    try { // expired: let supabase-js refresh it
      if (window.supabase && window.supabase.createClient) {
        sbClient = sbClient || window.supabase.createClient(SB_URL, SB_KEY);
        const r = await sbClient.auth.getSession();
        if (r && r.data && r.data.session) return r.data.session.access_token;
      }
    } catch {}
    return s && s.access_token ? s.access_token : null;
  }

  function popup(message) {
    if (document.getElementById('cm-upgrade')) return;
    const o = document.createElement('div'); o.id = 'cm-upgrade';
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,sans-serif';
    o.innerHTML = '<div style="max-width:380px;width:100%;background:#101E14;border:1px solid #1C3324;border-radius:16px;padding:22px;text-align:center;color:#E8F5EC">' +
      '<div style="font-size:34px">🚀</div><div style="font-weight:800;font-size:17px;margin:6px 0 8px">You have used your free allowance</div>' +
      '<div id="cm-up-msg" style="font-size:13px;line-height:1.6;color:#C5D9CC"></div>' +
      '<div style="font-size:12px;color:#8BA89A;margin-top:10px">Starter: 7 PDFs, 70 TMA answers, unlimited AI chats, 100 quizzes</div>' +
      '<button id="cm-up-go" style="width:100%;margin-top:16px;height:46px;background:#2AF598;border:none;border-radius:999px;font-weight:800;font-size:14px;cursor:pointer;color:#060D09">See Starter bank transfer details</button>' +
      '<button id="cm-up-x" style="width:100%;margin-top:8px;height:40px;background:transparent;border:1px solid #1C3324;border-radius:999px;color:#8BA89A;font-size:13px;cursor:pointer">Maybe later</button></div>';
    document.body.appendChild(o);
    o.querySelector('#cm-up-msg').textContent = message || 'Upgrade to keep studying.';
    o.querySelector('#cm-up-x').onclick = () => o.remove();
    o.querySelector('#cm-up-go').onclick = () => { location.href = '/index.html#pricing'; };
  }

  window.cmUpgradePopup = popup;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = /^\/api\//.test(url) || url.indexOf(location.origin + '/api/') === 0;
    if (!isApi) return realFetch(input, init);
    init = Object.assign({}, init); const h = new Headers(init.headers || {});
    const t = await token(); if (t && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + t);
    init.headers = h;
    const res = await realFetch(input, init);
    if (res.status === 402) { res.clone().json().then(j => popup(j && j.error)).catch(() => popup()); }
    else if (res.status === 401 && !/pay\/callback/.test(url)) { setTimeout(() => { alert('Your session expired. Please log in again.'); location.href = '/'; }, 50); }
    return res;
  };

  window.cmUploadPdf = async function (file) {
    const ready = await window.fetch('/api/materials/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size })
    });
    const upload = await ready.json().catch(() => ({}));
    if (!ready.ok) throw new Error(upload.error || 'Could not prepare PDF upload.');
    if (!upload.direct) {
      const form = new FormData();
      form.append('file', file);
      return window.fetch('/api/materials/upload', { method: 'POST', body: form });
    }
    if (!window.supabase || !window.supabase.createClient) throw new Error('Secure PDF upload is unavailable. Reload the page and try again.');
    sbClient = sbClient || window.supabase.createClient(SB_URL, SB_KEY);
    const result = await sbClient.storage.from('coursemate-files').uploadToSignedUrl(
      upload.path, upload.token, file, { contentType: 'application/pdf', upsert: true }
    );
    if (result.error) throw new Error(result.error.message || 'Could not upload PDF to secure storage.');
    return window.fetch('/api/materials/complete-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: upload.id, filename: file.name })
    });
  };

  window.cmUploadReceipt = async function (file) {
    const ready = await window.fetch('/api/pay/manual-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type })
    });
    const upload = await ready.json().catch(() => ({}));
    if (!ready.ok) throw new Error(upload.error || 'Could not prepare receipt upload.');
    if (!upload.direct) {
      const form = new FormData();
      form.append('receipt', file);
      return window.fetch('/api/pay/manual-submissions', { method: 'POST', body: form });
    }
    if (!window.supabase || !window.supabase.createClient) throw new Error('Secure receipt upload is unavailable. Reload the page and try again.');
    sbClient = sbClient || window.supabase.createClient(SB_URL, SB_KEY);
    const result = await sbClient.storage.from('coursemate-receipts').uploadToSignedUrl(
      upload.path, upload.token, file, { contentType: file.type, upsert: true }
    );
    if (result.error) throw new Error(result.error.message || 'Could not upload receipt to secure storage.');
    return window.fetch('/api/pay/manual-submissions/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: upload.id, path: upload.path })
    });
  };
})();
