// Fixed auth.js - v8.2 - Admin: oliverjohnthebaptist@gmail.com gets direct dashboard, students must complete profile
const ADMIN_EMAIL = "oliverjohnthebaptist@gmail.com";

function showCongrats(type, name, email) {
  let old = document.getElementById('congratsOverlay');
  if (old) old.remove();

  const isSignup = type === 'signup';
  const title = isSignup? `🎉 Congratulations ${name}!` : `👋 Welcome back, ${name}!`;
  const desc = isSignup
   ? `Your CourseMate account created!<br><br><b style="color:#2AF598">NOUN Success System ready</b><br><br><span style="font-size:12px;color:#8CA898">${email}</span>`
    : `Great to see you again!<br><br>Ready to crush TMAs?<br><br><span style="font-size:12px;color:#8CA898">${email}</span>`;

  const html = `
  <div id="congratsOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px">
    <div style="width:100%;max-width:440px;background:linear-gradient(180deg,#14281D,#0E2016);border:2px solid #2AF598;border-radius:24px;padding:32px;text-align:center;box-shadow:0 20px 60px rgba(42,245,152,0.25)">
      <div style="font-size:64px;margin-bottom:12px">${isSignup? '🎉' : '👋'}</div>
      <h2 style="color:#2AF598;font-size:24px;margin-bottom:10px">${title}</h2>
      <p style="color:#E8EDE7;line-height:1.6;font-size:14px">${desc}</p>
      <button id="congratsContinue" style="margin-top:20px;width:100%;background:#2AF598;color:#000;border:none;padding:14px;border-radius:14px;font-weight:800;cursor:pointer">Continue 🚀</button>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  document.getElementById('congratsContinue').onclick = async () => {
    await handleRedirect(email);
  };
  // Auto redirect after 3s
  setTimeout(async () => { await handleRedirect(email); }, isSignup? 4000 : 3000);
}

async function handleRedirect(email) {
  // Admin goes direct to dashboard
  if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
    window.location.href = '/public/html/dashboard.html';
    return;
  }
  // Students - check if profile complete
  try {
    const token = localStorage.getItem('sb-access-token') || sessionStorage.getItem('sb-access-token');
    // Try to get token from supabase
    let authToken = token;
    if (!authToken && window.supabaseClient) {
      const { data } = await window.supabaseClient.auth.getSession();
      authToken = data?.session?.access_token;
    }
    if (!authToken) {
      window.location.href = '/public/html/complete-profile.html';
      return;
    }
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${authToken}` }});
    const me = await res.json();
    if (me.needsProfile) {
      window.location.href = '/public/html/complete-profile.html';
    } else {
      window.location.href = '/public/html/dashboard.html';
    }
  } catch {
    window.location.href = '/public/html/complete-profile.html';
  }
}

function toggleEye(id, el) {
  const i = document.getElementById(id);
  if (!i) return;
  i.type = i.type === 'password'? 'text' : 'password';
  if (el) el.textContent = i.type === 'password'? '👁' : '🙈';
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email')?.value.trim();
      const password = document.getElementById('password')?.value.trim();
      if (!email ||!password) return alert('Enter email & password');
      const sb = window.supabaseClient || window.supabase;
      if (!sb) return alert('Supabase not loaded');
      try {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        let name = email.split('@')[0];
        try {
          const { data: prof } = await sb.from('profiles').select('full_name,nickname').eq('id', data.user.id).single();
          if (prof) name = prof.nickname || prof.full_name?.split(' ')[0] || name;
        } catch {}
        localStorage.setItem('sb-access-token', data.session.access_token);
        showCongrats('login', name, email);
      } catch (err) {
        alert('❌ ' + err.message);
      }
    });
  }

  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email')?.value.trim();
      const password = document.getElementById('password')?.value.trim();
      const name = document.getElementById('fullName')?.value.trim() || email.split('@')[0];
      if (!email ||!password) return alert('Enter email & password');
      const sb = window.supabaseClient || window.supabase;
      if (!sb) return alert('Supabase not loaded');
      try {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name }}});
        if (error) throw error;
        if (data.session) localStorage.setItem('sb-access-token', data.session.access_token);
        showCongrats('signup', name, email);
      } catch (err) {
        alert('❌ ' + err.message);
      }
    });
  }
});

window.showCongrats = showCongrats;
window.toggleEye = toggleEye;