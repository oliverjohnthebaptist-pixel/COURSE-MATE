// dashboard.js - RECHECKED - Same nav bar as materials + TMA button fix
const SUPABASE_URL = 'https://lohjifbvrbnqxamroxtp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-3UptBHer0fKyelp_a3z-g_jfflZF0l';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PLANS = {
  free: { name: 'Free', pdf: 3, tma: 15, summary: 999, quiz: 20, ai: true },
  starter: { name: 'Starter', pdf: 7, tma: 70, summary: 999, quiz: 100, ai: true },
  pro: { name: 'Pro', pdf: 999, tma: 9999, summary: 9999, quiz: 9999, ai: true }
};

let currentPlan = 'free';
let materials = [];
let currentUser = null;
let serverMe = null;
const isUnlimited = limit => Number(limit) >= 999999;
const limitLabel = limit => isUnlimited(limit) ? 'Unlimited' : limit;
const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const q = new URLSearchParams(location.search);
  if (q.get('paid') === '1') setTimeout(() => alert('🎉 Payment received! Your Starter plan is now active.'), 400);
  if (q.get('paid') === '0') setTimeout(() => alert('We could not confirm your payment yet. If you were charged, your plan will activate within a few minutes.'), 400);
  await loadUser();
  await loadMaterials();
  setupAvatarDropdown();
  setupUpload();
  if (serverMe && serverMe.user && serverMe.user.isAdmin) {
    const adminLink = document.getElementById('adminPaymentsLink');
    if (adminLink) adminLink.style.display = 'block';
  }
}

async function loadUser() {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) { 
      // allow demo without auth for testing
      document.getElementById('profName').textContent='Oliver';
      return;
    }
    currentUser = user;
    let { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', user.id).single();
    if (!profile) {   // first visit after "Continue with Google": create the profile automatically (no form to fill)
      const md = user.user_metadata || {};
      const fn = md.full_name || md.name || (user.email || '').split('@')[0];
      const row = { id: user.id, full_name: fn, nickname: md.given_name || fn.split(' ')[0], email: user.email, plan: 'free' };
      try { await supabaseClient.from('profiles').upsert(row); } catch (e) { console.log('profile create skipped', e); }
      profile = row;
    }
    const fullName = profile?.full_name || user.email || 'Oliver John';
    const firstName = (profile?.nickname || fullName).split(' ')[0];
    const email = profile?.email || user.email || 'oliver@email.com';
    currentPlan = profile?.plan || localStorage.getItem('user_plan') || 'free';
    try {
      const response = await fetch('/api/me');
      if (response.ok) {
        serverMe = await response.json();
        if (serverMe.unlimited) {
          PLANS.vip = { name: 'Starter', pdf: serverMe.limits.pdf, tma: serverMe.limits.tma, summary: 999999, quiz: serverMe.limits.quiz, ai: true };
          currentPlan = 'vip';
        } else if (PLANS[serverMe.plan]) currentPlan = serverMe.plan;
      }
    } catch {} // the server is the source of truth for the plan

    document.getElementById('profName').textContent = firstName;
    document.getElementById('profPlan').textContent = `${PLANS[currentPlan].name} Plan • ${limitLabel(PLANS[currentPlan].pdf)} PDFs`;
    document.getElementById('avatarLetter').textContent = firstName[0].toUpperCase();
    document.getElementById('dropName').textContent = fullName;
    document.getElementById('dropEmail').textContent = email;
    document.getElementById('dropAvatarLetter').textContent = firstName[0].toUpperCase();

    const savedAvatar = localStorage.getItem(`avatar_${user.id}`) || profile?.avatar_url;
    if (savedAvatar) setAvatarImage(savedAvatar);

    document.getElementById('dropPlanBadge').textContent = `${PLANS[currentPlan].name} • ${materials.length}/${limitLabel(PLANS[currentPlan].pdf)} PDFs`;

    if (currentPlan !== 'free') {
      document.getElementById('aiText').innerHTML = `AI Tutor unlimited • Starter<br><span style="color:#2AF598">Groq AI</span>`;
      document.getElementById('upgradeBtn').style.display = 'none';
    } else {
      document.getElementById('aiText').innerHTML = `Free: 20 AI Tutor chats<br><span style="color:#2AF598">Starter ₦4,500 = unlimited chats</span>`;
    }
    try { const h = await (await fetch('/api/health')).json(); document.getElementById('aiStatus').textContent = h.ai_key ? '● AI Active • Ready' : '● AI not configured'; } catch {}
  } catch (e) { console.log('loadUser error', e); }
}

function setupAvatarDropdown() {
  const wrap = document.getElementById('avatarWrap');
  const avatar = document.getElementById('profAvatar');
  const dd = document.getElementById('avatarDropdown');
  const input = document.getElementById('avatarInput');
  if (!wrap || !avatar || !dd) return;
  avatar.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('show'); });
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.avatar') || e.target.closest('.profile-text')) dd.classList.toggle('show');
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) dd.classList.remove('show'); });
  if (input) input.addEventListener('change', handleAvatarUpload);
}

function handleUploadPhoto() { document.getElementById('avatarInput').click(); }

function handleAvatarUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('Image too large. Max 5MB'); return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const base64 = ev.target.result;
    setAvatarImage(base64);
    if (currentUser) localStorage.setItem(`avatar_${currentUser.id}`, base64);
    document.getElementById('avatarDropdown').classList.remove('show');
  };
  reader.readAsDataURL(file);
}

function setAvatarImage(src) {
  const photo = document.getElementById('avatarPhoto');
  const letter = document.getElementById('avatarLetter');
  const dropAv = document.getElementById('dropAvatar');
  if (photo) { photo.src = src; photo.style.display = 'block'; }
  if (letter) letter.style.display = 'none';
  if (dropAv) dropAv.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover">`;
}

function handleProfile() { document.getElementById('avatarDropdown').classList.remove('show'); location.href = 'settings.html'; }
async function handleLogout() {
  if (!confirm('Logout?')) return;
  try { await supabaseClient.auth.signOut(); } catch {}
  localStorage.clear();
  location.href = '../../index.html';
}

async function loadMaterials() {
  try {
    const res = await fetch('/api/materials');
    const data = await res.json();
    materials = data.materials || data || [];
    const plan = PLANS[currentPlan];

    document.getElementById('matCount').textContent = materials.length;
    document.getElementById('pdfTag').textContent = `${materials.length}/${limitLabel(plan.pdf)} ${plan.name}`;
    document.getElementById('pdfBar').style.width = Math.min(100, (materials.length / plan.pdf) * 100) + '%';
    document.getElementById('pdfBar').style.background = materials.length >= plan.pdf ? '#ff6b6b' : '#2AF598';
    document.getElementById('pdfText').textContent = materials.length >= plan.pdf ? '⚠ Limit reached — Upgrade to Starter 7 PDFs ₦4,500' : `Free = 3 PDFs, Starter = 7 PDFs (70 TMA)`;
    document.getElementById('dropMatCount').textContent = materials.length;
    document.getElementById('dropPlanBadge').textContent = `${plan.name} • ${materials.length}/${limitLabel(plan.pdf)} PDFs`;
    document.getElementById('profPlan').textContent = `${plan.name} Plan • ${materials.length}/${limitLabel(plan.pdf)} PDFs`;

    let totalTMA = 0;
    for (let m of materials) {
      try { const hRes = await fetch(`/api/tma/history/${m.id}`); const hData = await hRes.json(); totalTMA += hData.total || 0; } catch {}
    }
    let totalQuiz = serverMe ? (Number(serverMe.usage.quiz) || 0) : parseInt(localStorage.getItem('quiz_count') || '0');
    const quizLimit = serverMe ? serverMe.limits.quiz : plan.quiz;
    const shownQuizLimit = quizLimit >= 999999 ? 'Unlimited' : quizLimit;

    document.getElementById('tmaCount').textContent = totalTMA;
    document.getElementById('tmaTag').textContent = `${totalTMA}/${limitLabel(plan.tma)} ${plan.name}`;
    document.getElementById('tmaBar').style.width = Math.min(100, (totalTMA / plan.tma) * 100) + '%';
    document.getElementById('quizCount').textContent = totalQuiz;
    document.getElementById('quizTag').textContent = `${totalQuiz}/${shownQuizLimit} ${plan.name}`;
    document.getElementById('quizBar').style.width = quizLimit >= 999999 ? '0%' : Math.min(100, (totalQuiz / quizLimit) * 100) + '%';
    document.getElementById('quizText').textContent = quizLimit >= 999999 ? 'Unlimited quizzes' : `${plan.name} allows ${quizLimit} quizzes`;
    document.getElementById('heroStatus').textContent = materials.length > 0 ? `${materials.length} courses ready` : 'ready';

    const listEl = document.getElementById('materialList');
    if (materials.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#7A9A85;font-size:13px">No materials yet — upload your first PDF to start 🚀<br><span style="font-size:11px">Free allows 3 PDFs (15 TMA, 20 quizzes, 20 AI chats)</span></div>`;
    } else {
      listEl.innerHTML = materials.slice(0,5).map(m => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1C3324">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(m.title)}</div>
            <div style="font-size:11px;color:#7A9A85">${m.page_count || 0} pages • ${new Date(m.created_at).toLocaleDateString()}</div>
          </div>
          <button onclick="location.href='tma.html?mat=${m.id}'" style="background:#111F18;color:#2AF598;border:1px solid #1C3324;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:700;cursor:pointer;margin-left:8px">Solve TMA →</button>
        </div>
      `).join('');
    }

    const actEl = document.getElementById('activityList');
    if (materials.length === 0) actEl.innerHTML = `No activity yet`;
    else actEl.innerHTML = materials.slice(0,5).map(m => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1C3324"><span>📄 ${escapeHTML(String(m.title || '').slice(0,25))}</span><span style="color:#2AF598;font-size:10px">${new Date(m.created_at).toLocaleDateString()}</span></div>`).join('');

  } catch (e) {
    document.getElementById('materialList').innerHTML = `Failed to load: ${e.message}<br>Is server running? node server.js`;
  }
}

function setupUpload() {
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');
  const uploadBtn = document.getElementById('uploadBtn');
  if (!fileInput || !dropZone) return;
  if (uploadBtn) uploadBtn.onclick = () => fileInput.click();
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
}

async function handleFile(file) {
  const plan = PLANS[currentPlan];
  if (materials.length >= plan.pdf) {
    alert(`❌ Your ${plan.name} plan allows only ${plan.pdf} PDFs.\nFree = 3 PDFs (15 TMA)\nStarter = 7 PDFs (70 TMA) ₦4,500/month`);
    if (window.cmUpgradePopup) window.cmUpgradePopup('Upgrade to Starter to add more PDFs.');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) { alert('PDF only'); return; }
  document.getElementById('fileName').textContent = '📄 ' + file.name;
  document.getElementById('uploadStatus').textContent = 'Uploading and saving safely...';
  try {
    const res = await window.cmUploadPdf(file);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    document.getElementById('uploadStatus').textContent = data.material?.scanned
      ? `⚠ ${data.title || file.name} saved, but appears to be scanned/image-only. OCR is not available; searchable text is needed.`
      : `✅ ${data.title || file.name} saved! (${materials.length + 1}/${plan.pdf})`;
    await loadMaterials();
  } catch (err) {
    document.getElementById('uploadStatus').textContent = '❌ ' + err.message;
  }
}

window.handleProfile = handleProfile;
window.handleUploadPhoto = handleUploadPhoto;
window.handleLogout = handleLogout;
window.handleFile = handleFile;