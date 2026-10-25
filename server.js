// CourseMate v1 backend - FIXED FOR TIMEOUT + PAGE SPLIT (Option A)
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { AsyncLocalStorage } = require('async_hooks');
const GroqLib = require('groq-sdk');
const Groq = GroqLib.Groq || GroqLib.default || GroqLib;
const cloudStore = require('./supabase-store');
const jobs = require('./ai-jobs');

const E = require('./tma_engine');
const AI = require('./ai');
const F = require('./features');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_ANON_KEY || '';
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const CLOUD_DATA = !!SB_SERVICE;
const STARTER_PRICE = 4500;
const REQUIRE_AUTH = !!SB_URL;
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_REQUEST_TIMEOUT_MS = process.env.GROQ_REQUEST_TIMEOUT_MS === undefined ? 10 * 60 * 1000 : Number(process.env.GROQ_REQUEST_TIMEOUT_MS);
const PRODUCTION = process.env.NODE_ENV === 'production';
if (!Number.isSafeInteger(GROQ_REQUEST_TIMEOUT_MS) || GROQ_REQUEST_TIMEOUT_MS <= 0) {
  throw new Error('GROQ_REQUEST_TIMEOUT_MS must be a positive integer number of milliseconds.');
}
const ADMINS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const FEEDBACK_RECIPIENTS = ADMINS.length ? ADMINS : ['oliverjohnthebaptist@gmail.com'];
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || '';

const ROOT = __dirname;
const STORAGE_ROOT = process.env.COURSEMATE_STORAGE_DIR ? path.resolve(process.env.COURSEMATE_STORAGE_DIR) : null;
const DATA_DIR = STORAGE_ROOT ? path.join(STORAGE_ROOT, 'data') : path.join(ROOT, 'data');
const UPLOAD_DIR = STORAGE_ROOT ? path.join(STORAGE_ROOT, 'uploads') : path.join(ROOT, 'uploads');
const CACHE_DIR = STORAGE_ROOT ? path.join(STORAGE_ROOT, 'page_cache') : path.join(ROOT, 'page_cache');
const PAYMENT_EVIDENCE_DIR = path.join(DATA_DIR, 'payment-evidence');
if (!CLOUD_DATA) [DATA_DIR, UPLOAD_DIR, CACHE_DIR, PAYMENT_EVIDENCE_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

if (PRODUCTION) {
  const missing = [];
  if (!SB_URL || !SB_KEY) missing.push('SUPABASE_URL and SUPABASE_ANON_KEY');
  if (!SB_SERVICE) missing.push('SUPABASE_SERVICE_KEY');
  if (!GROQ_KEY) missing.push('GROQ_API_KEY');
  if (!process.env.APP_URL || !/^https:\/\//i.test(process.env.APP_URL)) missing.push('APP_URL (an https:// production URL)');
  if (missing.length) throw new Error(`Production configuration is incomplete. Set: ${missing.join(', ')}.`);
} else if (!REQUIRE_AUTH) {
  console.warn('[config] Supabase auth is disabled; local development mode only.');
}

const UNLIMITED = 999999;
const PLANS = {
  free:    { name: 'Free',    pdf: 3, tma: 15, chat: 20,        quiz: 20,  price: 0 },
  starter: { name: 'Starter', pdf: 7, tma: 70, chat: UNLIMITED, quiz: 100, price: STARTER_PRICE }
};

function makeStore(file, def) {
  let data = def;
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`Persistent store ${file} contains invalid JSON: ${e.message}`); }
  }
  return {
    get: () => data,
    save() {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    }
  };
}
const localMATS = makeStore(path.join(DATA_DIR, 'materials.json'), []);
const localHIST = makeStore(path.join(DATA_DIR, 'tma_history.json'), []);
const localUSERS = makeStore(path.join(DATA_DIR, 'users.json'), {});
const localPAYMENT_SUBMISSIONS = makeStore(path.join(DATA_DIR, 'payment_submissions.json'), []);
const QUIZ_FILE = path.join(DATA_DIR, 'quiz_results.json');
const SUM_FILE = path.join(DATA_DIR, 'summaries.json');
function migrateLegacyFile(name, destination) {
  const legacy = path.join(ROOT, name);
  if (!fs.existsSync(destination) && fs.existsSync(legacy)) fs.copyFileSync(legacy, destination);
}
if (!CLOUD_DATA) {
  migrateLegacyFile('quiz_results.json', QUIZ_FILE);
  migrateLegacyFile('summaries.json', SUM_FILE);
}
const rd = (f, d) => {
  if (!fs.existsSync(f)) return d;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`Persistent store ${f} contains invalid JSON: ${e.message}`); }
};
const wr = (f, d) => {
  const t = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(t, JSON.stringify(d));
  fs.renameSync(t, f);
};

const MATS = {
  get: () => CLOUD_DATA ? (ctx().materials || []) : localMATS.get(),
  async save() {
    if (!CLOUD_DATA) return localMATS.save();
    const uid = ctx().uid;
    const rows = this.get().map(material => {
      if (!material.storage_path) throw new Error(`Material ${material.id} is missing its Supabase storage path.`);
      return {
        id: String(material.id), user_id: uid, storage_path: material.storage_path,
        metadata: { ...material, file_path: null, storage_path: material.storage_path },
        created_at: material.created_at || new Date().toISOString()
      };
    });
    await cloudStore.upsert('cm_materials', rows, 'id');
  }
};
const HIST = {
  get: () => CLOUD_DATA ? (ctx().history || []) : localHIST.get(),
  async save() {
    if (!CLOUD_DATA) return localHIST.save();
    const rows = this.get().map(item => ({
      user_id: item.user_id, material_id: String(item.material_id), payload: item,
      updated_at: item.updated_at || new Date().toISOString()
    }));
    await cloudStore.upsert('cm_tma_history', rows, 'user_id,material_id');
  }
};
const USERS = {
  get: () => localUSERS.get(),
  async save() {
    if (!CLOUD_DATA) return localUSERS.save();
    const state = ctx().userState;
    if (!state) throw new Error('User state is not loaded for this request.');
    await cloudStore.upsert('cm_user_state', [{
      user_id: ctx().uid, email: String(state.email || ctx().user.email || ''),
      state, updated_at: new Date().toISOString()
    }], 'user_id');
  }
};
const PAYMENT_SUBMISSIONS = {
  get: () => CLOUD_DATA ? (ctx().payments || []) : localPAYMENT_SUBMISSIONS.get(),
  async save() {
    if (!CLOUD_DATA) return localPAYMENT_SUBMISSIONS.save();
    const rows = this.get().map(item => ({
      id: item.id, user_id: item.user_id, receipt_path: item.receipt_path || item.receipt || null,
      payload: { ...item, receipt: null, receipt_path: item.receipt_path || item.receipt || null },
      created_at: item.created_at || new Date().toISOString()
    }));
    await cloudStore.upsert('cm_payment_submissions', rows, 'id');
  }
};

const als = new AsyncLocalStorage();
const ctx = () => als.getStore() || {};

function getUser(uid, email) {
  if (CLOUD_DATA && ctx().userState) {
    const user = ctx().userState;
    if (email && user.email !== email) user.email = email;
    return user;
  }
  const all = USERS.get();
  if (!all[uid]) { all[uid] = { plan: 'free', plan_expires: 0, usage: { tma: 0, chat: 0, quiz: 0 }, refs: [], created: Date.now() }; }
  if (email && all[uid].email !== email) all[uid].email = email;
  return all[uid];
}
function planOf(u) {
  if (u.plan === 'starter' && u.plan_expires && Date.now() > u.plan_expires) return 'free';
  return u.plan in PLANS ? u.plan : 'free';
}
const VIP = { name: 'Starter', pdf: UNLIMITED, tma: UNLIMITED, chat: UNLIMITED, quiz: UNLIMITED, price: 0 };
const isOwner = () => !!(ctx().user && ctx().user.admin);
function limitsFor(uid) {
  const u = getUser(uid);
  if (isOwner() && ctx().uid === uid) return { key: 'vip', plan: VIP, u };
  const key = planOf(u); return { key, plan: PLANS[key], u };
}
function myMaterials() { return MATS.get().filter(m => m.user_id === ctx().uid); }
async function bump(uid, kind, n = 1) {
  const u = getUser(uid);
  u.usage[kind] = (u.usage[kind] || 0) + n;
  await USERS.save();
}
function limitHit(res, what, used, max, extra = '') {
  return res.status(402).json({
    error: `Plan limit reached (${used}/${max} ${what}). ${extra}Upgrade to Starter (N${STARTER_PRICE.toLocaleString()}/month) to continue.`,
    code: 'LIMIT', upgrade: true, what
  });
}

// --- NEW: helper to split PDF into pages and save to pdf_pages table (Option A) ---
async function splitPdfAndSave(pdfBuffer, mainPdfId) {
  if (!CLOUD_DATA) return 0;
  try {
    const doc = await pdfjsLib.getDocument({ data: pdfBuffer }).promise;
    const total = doc.numPages;
    let saved = 0;
    const batch = [];
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(s => s.str || '').join(' ').trim();
      if (text.length > 20) {
        batch.push({ main_pdf_id: String(mainPdfId), page_number: i, page_text: text.slice(0, 8000) });
      }
      // insert in batches of 30 to avoid timeout
      if (batch.length >= 30) {
        await cloudStore.insert('pdf_pages', batch);
        saved += batch.length;
        batch.length = 0;
      }
    }
    if (batch.length) {
      await cloudStore.insert('pdf_pages', batch);
      saved += batch.length;
    }
    return saved;
  } catch (e) {
    console.error('[split] failed', e);
    return 0;
  }
}

// --- NEW: Patch E.getPages to use split pages first (fixes timeout) ---
const originalGetPages = E.getPages.bind(E);
E.getPages = async (row) => {
  if (CLOUD_DATA && row && row.id) {
    try {
      const rows = await cloudStore.select('pdf_pages', { main_pdf_id: row.id });
      if (rows && rows.length) {
        rows.sort((a, b) => a.page_number - b.page_number);
        const pages = rows.map(r => r.page_text || '');
        if (pages.length) return { pages, page_numbers: rows.map(r => r.page_number), scanned: false };
      }
    } catch (err) {
      console.warn('[getPages] pdf_pages fallback', err.message);
    }
  }
  return originalGetPages(row);
};

const app = express();
const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const sendFile = f => (req, res) => fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('Not found');
app.get('/', sendFile(path.join(ROOT, 'index.html')));
['index.html', 'login.html', 'signup.html', 'logo.png', 'logo-mascot.webp'].forEach(f => app.get('/' + f, sendFile(path.join(ROOT, f))));
app.use('/css', express.static(path.join(ROOT, 'public/css'), { maxAge: '1d' }));
app.use('/js', express.static(path.join(ROOT, 'public/js'), { maxAge: '5m' }));
app.use('/public', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));
const page = f => (req, res) => { const p = path.join(ROOT, 'public/html', f); fs.existsSync(p) ? res.sendFile(p) : res.status(404).send('Not found: ' + f); };
app.get(['/payments.html', '/public/html/payments.html'], page('payments.html'));
app.get(['/payment.html', '/public/html/payment.html'], page('payment.html'));
['dashboard', 'materials', 'tma', 'summary', 'quiz', 'chat', 'settings', 'auth', 'landing'].forEach(n => {
  app.get(['/' + n + '.html', '/public/html/' + n + '.html'], page(n + '.html'));
});
app.get('/html/:file', (req, res) => page(path.basename(req.params.file))(req, res));

const ADMIN_EMAIL = "oliverjohnthebaptist@gmail.com";

app.get('/api/profile/check', (req, res) => {
  res.json({ ok: true });
});
const groq = GROQ_KEY ? new Groq({ apiKey: GROQ_KEY, timeout: GROQ_REQUEST_TIMEOUT_MS }) : null;
app.get('/api/health', async (req, res) => {
  const out = { ok: true, engine: E.ENGINE_VERSION, ai_key: !!GROQ_KEY, ai: AI.status(), login_check: REQUIRE_AUTH };
  if (req.query.deep === '1') {
    try { const r = await E.callModel(groq, 'Reply with the single word OK.', 'ping', 64); out.ai_live = /ok/i.test(String(r)); }
    catch (e) { out.ai_live = false; out.ai_error = AI.friendly(e); out.ai_kind = e && e.kind; }
  }
  res.json(out);
});

async function activateStarter(uid, ref, email) {
  let u;
  if (CLOUD_DATA) {
    const rows = await cloudStore.select('cm_user_state', { user_id: uid });
    u = rows[0] && rows[0].state && typeof rows[0].state === 'object'
      ? rows[0].state
      : { plan: 'free', plan_expires: 0, usage: { tma: 0, chat: 0, quiz: 0 }, refs: [], created: Date.now() };
    if (email) u.email = email;
  } else {
    u = getUser(uid, email);
  }
  if (!Array.isArray(u.refs)) u.refs = [];
  if (ref && u.refs.includes(ref)) return false;
  const base = u.plan === 'starter' && u.plan_expires > Date.now() ? u.plan_expires : Date.now();
  u.plan = 'starter'; u.plan_expires = base + 30 * 24 * 3600 * 1000;
  u.usage = { tma: 0, chat: 0, quiz: 0 };
  if (ref) u.refs.push(ref);
  if (CLOUD_DATA) {
    await cloudStore.upsert('cm_user_state', [{
      user_id: uid, email: String(email || u.email || ''), state: u, updated_at: new Date().toISOString()
    }], 'user_id');
  } else {
    await USERS.save();
  }
  if (SB_URL && SB_SERVICE) {
    fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', headers: { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ plan: 'starter' })
    }).catch(() => {});
  }
  console.log(`[pay] Starter activated for ${uid} ref=${ref}`);
  return true;
}
const tokCache = new Map();
async function loadCloudRequestData(user) {
  const [userRows, materialRows, historyRows, paymentRows, quizRows, summaryRows] = await Promise.all([
    cloudStore.select('cm_user_state', { user_id: user.id }),
    cloudStore.select('cm_materials', { user_id: user.id }),
    cloudStore.select('cm_tma_history', { user_id: user.id }),
    cloudStore.select('cm_payment_submissions', user.admin ? {} : { user_id: user.id }),
    cloudStore.select('cm_quiz_results', { user_id: user.id }),
    cloudStore.select('cm_summaries', { user_id: user.id })
  ]);
  const userState = userRows[0] && userRows[0].state && typeof userRows[0].state === 'object'
    ? userRows[0].state
    : { plan: 'free', plan_expires: 0, usage: { tma: 0, chat: 0, quiz: 0 }, refs: [], created: Date.now() };
  userState.email = user.email || userState.email || '';
  return {
    userState,
    materials: materialRows.map(row => ({ ...(row.metadata || {}), id: row.id, user_id: row.user_id, storage_path: row.storage_path, file_path: null })),
    history: historyRows.map(row => row.payload),
    quizzes: quizRows.map(row => row.payload),
    summaries: Object.fromEntries(summaryRows.map(row => [String(row.material_id), row.payload])),
    payments: paymentRows.map(row => {
      const payload = row.payload || {};
      return { ...payload, id: row.id, user_id: row.user_id, receipt: row.receipt_path || payload.receipt_path || payload.receipt || null, receipt_path: row.receipt_path || payload.receipt_path || null };
    })
  };
}

async function verifyToken(token) {
  const hit = tokCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: SB_KEY } });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.id) return null;
  const confirmed = !!(j.email_confirmed_at || j.confirmed_at);
  const user = { id: j.id, email: j.email || '', name: (j.user_metadata && (j.user_metadata.full_name || j.user_metadata.name)) || '',
    admin: confirmed && ADMINS.includes(String(j.email || '').toLowerCase()) };
  tokCache.set(token, { user, exp: Date.now() + 5 * 60 * 1000 });
  if (tokCache.size > 5000) tokCache.clear();
  return user;
}
app.use('/api', async (req, res, next) => {
  try {
    let user;
    if (!REQUIRE_AUTH) user = { id: 'dev', email: 'dev@local', name: 'Dev', admin: ADMINS.includes('dev@local') };
    else {
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      user = m ? await verifyToken(m[1]) : null;
      if (!user) return res.status(401).json({ error: 'Please log in again.', code: 'AUTH' });
    }
    const data = CLOUD_DATA ? await loadCloudRequestData(user) : {};
    als.run({ uid: user.id, user, ...data }, () => {
      if (!CLOUD_DATA) getUser(user.id, user.email);
      next();
    });
  } catch (e) {
    console.error('[auth/storage] request setup failed', e);
    res.status(CLOUD_DATA ? 503 : 401).json({ error: CLOUD_DATA ? 'Could not load your saved CourseMate data. Please retry.' : 'Login check failed. Try again.', code: CLOUD_DATA ? 'STORAGE' : 'AUTH' });
  }
});

const hits = new Map();
function aiRate(req, res, next) {
  if (!groq) return res.status(503).json({ error: 'AI is not configured yet (missing GROQ_API_KEY).' });
  if (isOwner()) return next();
  const k = ctx().uid, now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(k) || []).filter(t => now - t < win);
  if (arr.length >= 60) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
  arr.push(now); hits.set(k, arr); next();
}
function countOnSuccess(kind) {
  return (req, res, next) => {
    const uid = ctx().uid; let failed = false; let ending = false;
    const w = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...a) => { try { if (String(chunk).includes('"type":"error"')) failed = true; } catch {} return w(chunk, ...a); };
    res.end = (chunk, ...a) => {
      if (ending) return res;
      ending = true;
      if (res.statusCode !== 200 || failed) return end(chunk, ...a);
      bump(uid, kind).then(() => end(chunk, ...a)).catch(error => {
        console.error('[usage] could not persist usage', error);
        w(JSON.stringify({ type: 'error', error: 'Your result was generated, but your usage could not be saved. Please contact support before retrying.' }) + '\n');
        end(chunk, ...a);
      });
      return res;
    };
    next();
  };
}
function gate(kind, label) {
  return (req, res, next) => {
    const { plan, u } = limitsFor(ctx().uid);
    if (plan[kind] >= UNLIMITED) return next();
    const used = u.usage[kind] || 0;
    if (used >= plan[kind]) return limitHit(res, label, used, plan[kind]);
    next();
  };
}

app.get('/api/me', (req, res) => {
  const { key, plan, u } = limitsFor(ctx().uid);
  const isAdmin = isOwner();
  const needsProfile = !isAdmin && (!u.matric || !u.department);
  res.json({
    user: { id: ctx().uid, email: ctx().user.email, name: ctx().user.name, isAdmin },
    plan: key === 'vip' ? 'starter' : key, plan_name: plan.name, unlimited: key === 'vip' || isAdmin, expires: key === 'starter' ? u.plan_expires : null,
    limits: { pdf: plan.pdf, tma: plan.tma, chat: plan.chat, quiz: plan.quiz },
    usage: { pdf: myMaterials().length, tma: u.usage.tma || 0, chat: u.usage.chat || 0, quiz: u.usage.quiz || 0 },
    price: STARTER_PRICE,
    needsProfile,
    matric: u.matric || null,
    department: u.department || null
  });
});

const feedbackRequests = new Map();
app.post('/api/feedback', asyncHandler(async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (message.length < 3 || message.length > 5000) {
    return res.status(400).json({ error: 'Feedback must be between 3 and 5,000 characters.' });
  }
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return res.status(503).json({ error: 'Feedback email is not configured yet. Please contact the site administrator.' });
  }
  const uid = ctx().uid;
  const now = Date.now();
  const lastRequest = feedbackRequests.get(uid) || 0;
  if (now - lastRequest < 30_000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before sending more feedback.' });
  }
  feedbackRequests.set(uid, now);
  const user = ctx().user || {};
  const origin = req.get('origin') || APP_URL;
  const sender = [user.name, user.email].filter(Boolean).join(' — ') || 'Signed-in student';
  const text = [
    'New CourseMate feedback',
    `From: ${sender}`,
    `User ID: ${uid}`,
    `Page: ${origin}`,
    '',
    message
  ].join('\n');
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: FEEDBACK_RECIPIENTS,
        subject: 'CourseMate student feedback',
        text,
        ...(user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) ? { reply_to: user.email } : {})
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    feedbackRequests.delete(uid);
    console.error('[feedback] email provider request failed', error);
    return res.status(502).json({ error: 'Feedback could not be delivered right now. Please try again shortly.' });
  }
  if (!response.ok) {
    feedbackRequests.delete(uid);
    const providerMessage = await response.text().catch(() => '');
    console.error(`[feedback] email provider returned HTTP ${response.status}: ${providerMessage.slice(0, 500)}`);
    return res.status(502).json({ error: 'Feedback could not be delivered right now. Please try again shortly.' });
  }
  res.json({ ok: true });
}));

app.post('/api/profile/complete', asyncHandler(async (req, res) => {
  const { matric, department, level } = req.body || {};
  if (!matric || !department) return res.status(400).json({ error: 'Matric and department required' });
  const u = getUser(ctx().uid);
  u.matric = String(matric).trim();
  u.department = String(department).trim();
  u.level = String(level || '').trim();
  await USERS.save();
  res.json({ ok: true });
}));

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const validMime = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    const valid = file.fieldname === 'receipt' && validMime;
    cb(valid ? null : new Error('Upload one payment receipt as a JPG, PNG, WebP, or PDF file.'), valid);
  }
});
function evidenceType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
}
function adminOnly(req, res, next) {
  if (!ctx().user.admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}
function safeSubmission(submission) {
  return {
    id: submission.id, name: submission.name, email: submission.email,
    created_at: submission.created_at, status: submission.status,
    has_receipt: !!submission.receipt
  };
}
app.post('/api/pay/manual-submissions', (req, res, next) => {
  if (CLOUD_DATA) return res.status(400).json({ error: 'Use the secure receipt upload flow.' });
  evidenceUpload.single('receipt')(req, res, error => {
    if (error) return res.status(400).json({ error: error.message });
    next();
  });
}, async (req, res) => {
  const receipt = req.file;
  if (!receipt) return res.status(400).json({ error: 'Upload your payment receipt.' });
  const receiptType = evidenceType(receipt.buffer);
  const typeMatches = (file, type) => ({
    jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf'
  })[type] === file.mimetype;
  if (!receiptType || !typeMatches(receipt, receiptType)) {
    return res.status(400).json({ error: 'The receipt file is invalid. Upload a real JPG, PNG, WebP, or PDF file.' });
  }
  const existing = PAYMENT_SUBMISSIONS.get().find(s => s.user_id === ctx().uid && s.status === 'pending');
  if (existing) return res.status(409).json({ error: 'You already have a payment awaiting review.' });

  const id = crypto.randomUUID();
  const receiptName = `${id}-receipt.${receiptType}`;
  const receiptPath = CLOUD_DATA ? `${ctx().uid}/${id}/${receiptName}` : receiptName;
  try {
    if (CLOUD_DATA) await cloudStore.upload('coursemate-receipts', receiptPath, receipt.buffer, receipt.mimetype);
    else fs.writeFileSync(path.join(PAYMENT_EVIDENCE_DIR, receiptName), receipt.buffer, { flag: 'wx' });
    const submission = {
      id, user_id: ctx().uid, email: ctx().user.email, name: ctx().user.name || '',
      receipt: receiptPath, receipt_path: CLOUD_DATA ? receiptPath : null, status: 'pending',
      created_at: new Date().toISOString()
    };
    PAYMENT_SUBMISSIONS.get().push(submission);
    await PAYMENT_SUBMISSIONS.save();
    res.status(201).json({ ok: true, submission: safeSubmission(submission) });
  } catch (e) {
    const submissions = PAYMENT_SUBMISSIONS.get();
    const index = submissions.findIndex(s => s.id === id);
    if (index !== -1) submissions.splice(index, 1);
    try {
      if (CLOUD_DATA) await cloudStore.removeObject('coursemate-receipts', receiptPath);
      else fs.unlinkSync(path.join(PAYMENT_EVIDENCE_DIR, receiptName));
    } catch (cleanupError) { console.error('[pay] could not clean up failed receipt upload', cleanupError); }
    console.error('[pay] could not save manual payment submission', e);
    res.status(500).json({ error: 'Could not save your payment evidence. Please try again.' });
  }
});
app.get('/api/pay/manual-submissions', (req, res) => {
  const submissions = PAYMENT_SUBMISSIONS.get()
    .filter(s => s.user_id === ctx().uid)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(s => ({ status: s.status, created_at: s.created_at, code: s.code || null }));
  res.json({ submissions });
});
app.post('/api/pay/manual-upload-url', async (req, res) => {
  if (!CLOUD_DATA) return res.json({ direct: false });
  const existing = PAYMENT_SUBMISSIONS.get().find(s => s.user_id === ctx().uid && s.status === 'pending');
  if (existing) return res.status(409).json({ error: 'You already have a payment awaiting review.' });
  const { filename, size, contentType } = req.body || {};
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const extension = types[String(contentType || '').toLowerCase()];
  if (!extension || !/^[^\\/]+$/u.test(String(filename || ''))) {
    return res.status(400).json({ error: 'Choose a JPG, PNG, WebP, or PDF payment receipt.' });
  }
  if (!Number.isFinite(Number(size)) || Number(size) <= 0 || Number(size) > 8 * 1024 * 1024) {
    return res.status(400).json({ error: 'Payment receipts must be no larger than 8MB.' });
  }
  const id = crypto.randomUUID();
  const objectPath = `${ctx().uid}/${id}/${id}-receipt.${extension}`;
  try {
    const signed = await cloudStore.createSignedUpload('coursemate-receipts', objectPath);
    res.json({ direct: true, id, path: objectPath, token: signed.token });
  } catch (error) {
    console.error('[pay] could not create signed receipt upload', error);
    res.status(502).json({ error: 'Could not prepare a secure receipt upload. Please retry.' });
  }
});
app.post('/api/pay/manual-submissions/complete', async (req, res) => {
  if (!CLOUD_DATA) return res.status(404).json({ error: 'Not found' });
  const id = String((req.body || {}).id || '');
  const objectPath = String((req.body || {}).path || '');
  const prefix = `${ctx().uid}/${id}/`;
  const suffix = objectPath.startsWith(prefix) ? objectPath.slice(prefix.length) : '';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !new RegExp(`^${id}-receipt\\.(jpg|png|webp|pdf)$`, 'i').test(suffix)) {
    return res.status(400).json({ error: 'Receipt upload information is invalid.' });
  }
  const existing = PAYMENT_SUBMISSIONS.get().find(s => s.user_id === ctx().uid && s.status === 'pending');
  if (existing) {
    try { await cloudStore.removeObject('coursemate-receipts', objectPath); }
    catch (error) { console.error('[pay] could not remove duplicate pending receipt upload', error); }
    return res.status(409).json({ error: 'You already have a payment awaiting review.' });
  }
  try {
    const buffer = await cloudStore.download('coursemate-receipts', objectPath);
    const type = evidenceType(buffer);
    const expected = path.extname(suffix).slice(1).toLowerCase();
    if (!type || type !== expected) {
      await cloudStore.removeObject('coursemate-receipts', objectPath);
      return res.status(400).json({ error: 'The receipt file is invalid. Upload a real JPG, PNG, WebP, or PDF file.' });
    }
    const submission = {
      id, user_id: ctx().uid, email: ctx().user.email, name: ctx().user.name || '',
      receipt: objectPath, receipt_path: objectPath, status: 'pending',
      created_at: new Date().toISOString()
    };
    PAYMENT_SUBMISSIONS.get().push(submission);
    await PAYMENT_SUBMISSIONS.save();
    res.status(201).json({ ok: true, submission: safeSubmission(submission) });
  } catch (error) {
    PAYMENT_SUBMISSIONS.get().splice(0, PAYMENT_SUBMISSIONS.get().length, ...PAYMENT_SUBMISSIONS.get().filter(s => s.id !== id));
    try { await cloudStore.removeObject('coursemate-receipts', objectPath); }
    catch (cleanupError) { console.error('[pay] could not remove failed receipt upload', cleanupError); }
    console.error('[pay] could not complete receipt submission', error);
    res.status(500).json({ error: 'Could not save your payment evidence. Please try again.' });
  }
});
app.get('/api/admin/payments', adminOnly, (req, res) => {
  const submissions = PAYMENT_SUBMISSIONS.get()
    .slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(s => ({ ...safeSubmission(s), code: s.code || null }));
  res.json({ submissions });
});
app.get('/api/admin/payments/:id/:kind', adminOnly, async (req, res) => {
  const submission = PAYMENT_SUBMISSIONS.get().find(s => s.id === req.params.id);
  const filename = submission && req.params.kind === 'receipt' ? submission.receipt : null;
  if (!filename || (!CLOUD_DATA && path.basename(filename) !== filename)) return res.status(404).json({ error: 'Payment evidence not found.' });
  if (CLOUD_DATA) {
    try {
      const url = await cloudStore.createSignedDownload('coursemate-receipts', filename, 60);
      return res.json({ url });
    } catch (error) {
      console.error('[pay] could not load payment evidence', error);
      return res.status(500).json({ error: 'Could not load payment evidence. Please retry.' });
    }
  }
  const filePath = path.join(PAYMENT_EVIDENCE_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Payment evidence file is missing.' });
  const mimeTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
  res.type(mimeTypes[path.extname(filename).slice(1)] || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath);
});
app.post('/api/admin/payments/:id/activate', adminOnly, async (req, res) => {
  const submission = PAYMENT_SUBMISSIONS.get().find(s => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: 'Payment submission not found.' });
  if (submission.code) return res.status(409).json({ error: 'An activation code was already generated.', code: submission.code });
  if (submission.status !== 'pending') return res.status(409).json({ error: 'This payment submission has already been reviewed.' });
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = `CM-${Array.from(crypto.randomBytes(4), byte => alphabet[byte % alphabet.length]).join('')}-2026`; }
  while (PAYMENT_SUBMISSIONS.get().some(s => s.code === code));
  const originalStatus = submission.status;
  submission.code = code;
  submission.status = 'approved';
  try {
    await PAYMENT_SUBMISSIONS.save();
  } catch (e) {
    delete submission.code;
    submission.status = originalStatus;
    console.error('[pay] could not save activation code', e);
    return res.status(500).json({ error: 'Could not generate the activation code. Please retry.' });
  }
  res.status(201).json({ code });
});
app.post('/api/pay/redeem', asyncHandler(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!/^CM-[A-Z0-9]{4}-2026$/.test(code)) return res.status(400).json({ error: 'Enter a valid CourseMate activation code.' });
  const activation = PAYMENT_SUBMISSIONS.get().find(s => s.code === code);
  if (!activation) return res.status(404).json({ error: 'That activation code is invalid.' });
  if (activation.user_id !== ctx().uid) return res.status(403).json({ error: 'This activation code belongs to another student account.' });
  if (activation.redeemed_at) return res.status(409).json({ error: 'This activation code has already been used.' });
  await activateStarter(ctx().uid, `activation:${code}`, ctx().user.email);
  activation.redeemed_at = new Date().toISOString();
  await PAYMENT_SUBMISSIONS.save();
  res.json({ ok: true, plan: 'starter' });
}));

const storage = CLOUD_DATA ? multer.memoryStorage() : multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + String(file.originalname).replace(/[^\w.\- ]+/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
const publicRow = m => ({ id: m.id, title: m.title, file_name: m.file_name, page_count: m.page_count, char_count: m.char_count, scanned: !!m.scanned, created_at: m.created_at });

app.get('/api/materials', (req, res) => res.json({ materials: myMaterials().map(publicRow) }));
app.get('/api/materials/:id', (req, res) => {
  const m = myMaterials().find(x => x.id === req.params.id);
  m ? res.json(publicRow(m)) : res.status(404).json({ error: 'Not found' });
});

app.get('/api/materials', (req, res) => res.json({ materials: myMaterials().map(publicRow) }));

app.post('/api/materials/upload-url', async (req, res) => {
  if (!CLOUD_DATA) return res.json({ direct: false });
  const { plan } = limitsFor(ctx().uid);
  const n = myMaterials().length;
  if (n >= plan.pdf) return limitHit(res, 'PDFs', n, plan.pdf);
  const filename = String((req.body || {}).filename || '').trim();
  const size = Number((req.body || {}).size);
  if (!/\.pdf$/i.test(filename)) return res.status(400).json({ error: 'Only PDF files are allowed.' });
  if (!Number.isFinite(size) || size <= 0 || size > 100 * 1024 * 1024) {
    return res.status(400).json({ error: 'Choose a PDF that is no larger than 100MB.' });
  }
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const safeName = path.basename(filename).replace(/[^\w.\- ]+/g, '_');
  const objectPath = `${ctx().uid}/${id}/${safeName}`;
  try {
    const signed = await cloudStore.createSignedUpload('coursemate-files', objectPath);
    res.json({ direct: true, id, path: objectPath, token: signed.token });
  } catch (error) {
    console.error('[materials] could not create signed upload', error);
    res.status(502).json({ error: 'Could not prepare a secure PDF upload. Please retry.' });
  }
});

app.post('/api/materials/complete-upload', async (req, res) => {
  if (!CLOUD_DATA) return res.status(404).json({ error: 'Not found' });
  const id = String((req.body || {}).id || '');
  const filename = String((req.body || {}).filename || '');
  if (!/^[a-z0-9]+$/i.test(id) || !/\.pdf$/i.test(filename)) {
    return res.status(400).json({ error: 'Upload information is invalid.' });
  }
  const safeName = path.basename(filename).replace(/[^\w.\- ]+/g, '_');
  const objectPath = `${ctx().uid}/${id}/${safeName}`;
  if (myMaterials().some(material => material.id === id)) return res.status(409).json({ error: 'This upload has already been completed.' });
  const { plan } = limitsFor(ctx().uid);
  if (myMaterials().length >= plan.pdf) {
    try { await cloudStore.removeObject('coursemate-files', objectPath); }
    catch (error) { console.error('[materials] could not remove upload rejected by plan limit', error); }
    return limitHit(res, 'PDFs', myMaterials().length, plan.pdf);
  }
  try {
    const pdfBuffer = await cloudStore.download('coursemate-files', objectPath);
    if (pdfBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      await cloudStore.removeObject('coursemate-files', objectPath);
      return res.status(400).json({ error: 'Only real PDF files are allowed.' });
    }
    let parsed;
    try { parsed = await pdfParse(pdfBuffer, { max: 1 }); }
    catch {
      await cloudStore.removeObject('coursemate-files', objectPath);
      return res.status(400).json({ error: 'This PDF is damaged or password-protected.' });
    }
    const firstText = parsed.text || '';
    const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const duplicate = myMaterials().find(material => material.hash === hash);
    if (duplicate) {
      await cloudStore.removeObject('coursemate-files', objectPath);
      return res.status(409).json({
        error: `You already uploaded this PDF ("${duplicate.title}"). It is in your Safe Box.`,
        duplicate: true, id: duplicate.id
      });
    }
    const row = {
      id, user_id: ctx().uid, title: safeName.replace(/\.pdf$/i, ''), file_name: safeName,
      file_path: null, storage_path: objectPath, page_count: parsed.numpages || 0,
      char_count: 0, scanned: firstText.replace(/\s+/g, '').length < 40,
      hash, created_at: new Date().toISOString()
    };
    MATS.get().push(row);
    await MATS.save();

    // --- NEW: Split into pdf_pages in background (does not block response) ---
    splitPdfAndSave(pdfBuffer, id).then(count => {
      console.log(`[split] Saved ${count} pages for ${id}`);
    }).catch(e => console.error('[split] bg failed', e));

    res.json({ success: true, id, title: row.title, pages: row.page_count, material: publicRow(row) });
  } catch (error) {
    try { await cloudStore.removeObject('coursemate-files', objectPath); }
    catch (cleanupError) { console.error('[materials] could not remove incomplete secure upload', cleanupError); }
    console.error('[materials] could not complete secure upload', error);
    res.status(500).json({ error: 'Could not validate and save your PDF. Please retry.' });
  }
});

app.post('/api/materials/upload', (req, res, next) => {
  if (CLOUD_DATA) return res.status(400).json({ error: 'Use the secure PDF upload flow.' });
  const { plan } = limitsFor(ctx().uid); const n = myMaterials().length;
  if (n >= plan.pdf) return limitHit(res, 'PDFs', n, plan.pdf);
  next();
}, upload.single('file'), async (req, res) => {
  const f = req.file;
  let uploadedStoragePath = null;
  try {
    if (!f) return res.status(400).json({ error: 'No file received.' });
    const pdfBuffer = CLOUD_DATA ? f.buffer : fs.readFileSync(f.path);
    if (!/\.pdf$/i.test(f.originalname) || pdfBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      if (!CLOUD_DATA) fs.unlinkSync(f.path);
      return res.status(400).json({ error: 'Only real PDF files are allowed.' });
    }
    let pages = 0, firstText = '';
    try { const d = await pdfParse(pdfBuffer, { max: 1 }); pages = d.numpages || 0; firstText = d.text || ''; }
    catch (e) {
      if (!CLOUD_DATA) fs.unlinkSync(f.path);
      return res.status(400).json({ error: 'This PDF is damaged or password-protected.' });
    }
    const scanned = firstText.replace(/\s+/g, '').length < 40;
    const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const dup = myMaterials().find(m => m.hash === hash);
    if (dup) {
      if (!CLOUD_DATA) try { fs.unlinkSync(f.path); } catch {}
      return res.status(409).json({ error: `You already uploaded this PDF ("${dup.title}"). It is in your Safe Box.`, duplicate: true, id: dup.id });
    }
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const fileName = CLOUD_DATA ? String(f.originalname).replace(/[^\w.\- ]+/g, '_') : path.basename(f.path);
    const storagePath = CLOUD_DATA ? `${ctx().uid}/${id}/${fileName}` : null;
    uploadedStoragePath = storagePath;
    const row = {
      id, user_id: ctx().uid,
      title: f.originalname.replace(/\.pdf$/i, ''), file_name: fileName, file_path: CLOUD_DATA ? null : f.path,
      ...(CLOUD_DATA ? { storage_path: storagePath } : {}),
      page_count: pages, char_count: 0, scanned, hash, created_at: new Date().toISOString()
    };
    if (CLOUD_DATA) await cloudStore.upload('coursemate-files', storagePath, pdfBuffer, 'application/pdf');
    MATS.get().push(row);
    await MATS.save();
    if (!scanned) {
      splitPdfAndSave(pdfBuffer, id).catch(()=>{});
      E.getPages(row).then(async r => { row.char_count = r.pages.join('').length; await MATS.save(); }).catch(error => console.error('[materials] could not cache PDF text length', error));
    }
    res.json({ success: true, id: row.id, title: row.title, pages, material: publicRow(row) });
  } catch (e) {
    if (!CLOUD_DATA && f && f.path && fs.existsSync(f.path)) {
      try { fs.unlinkSync(f.path); } catch (cleanupError) { console.error('[materials] failed to remove incomplete local upload', cleanupError); }
    }
    if (CLOUD_DATA && uploadedStoragePath) {
      try { await cloudStore.removeObject('coursemate-files', uploadedStoragePath); }
      catch (cleanupError) { console.error('[materials] failed to remove incomplete Supabase upload', cleanupError); }
    }
    console.error('[materials] upload failed', e);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

app.delete('/api/materials/:id', (req, res) => res.status(403).json({ error: 'Materials cannot be deleted once uploaded.' }));

const mpOnly = multer().none();
app.get('/api/tma/history/:id', (req, res) => {
  if (!myMaterials().some(m => m.id === req.params.id)) return res.json({ total: 0, answers: [] });
  const e = HIST.get().find(h => h.material_id === req.params.id && h.user_id === ctx().uid);
  res.json({ total: e ? e.answers.length : 0, answers: e ? e.answers : [] });
});
app.post('/api/tma/clear/:id', asyncHandler(async (req, res) => {
  const h = HIST.get(); h.splice(0, h.length, ...h.filter(x => !(x.material_id === req.params.id && x.user_id === ctx().uid)));
  if (CLOUD_DATA) await cloudStore.remove('cm_tma_history', { user_id: ctx().uid, material_id: req.params.id });
  else await HIST.save();
  res.json({ ok: true });
}));

app.post('/api/tma/solve', aiRate, mpOnly, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const text = String(body.tma_text || '').trim().slice(0, 60000);
  const row = myMaterials().find(m => m.id === body.material_id);
  if (!row) return res.status(404).json({ error: 'Go to Materials and upload your PDF first.' });
  if (row.scanned) return res.status(422).json({ error: 'This PDF appears to be scanned/image-only. OCR is not available; upload a searchable PDF with selectable text.' });
  if (text.length < 10) return res.status(400).json({ error: 'Paste your TMA questions first.' });

  const { plan, u } = limitsFor(ctx().uid);
  const want = (E.extractTMA(text) || []).length;
  if (!want) return res.status(400).json({ error: 'Could not detect a question. Number each question (for example, 1.) and include its options if it is multiple choice.' });
  const left = plan.tma - (u.usage.tma || 0);
  if (left <= 0) return limitHit(res, 'TMA answers', u.usage.tma || 0, plan.tma);
  if (want > left) return limitHit(res, 'TMA answers', u.usage.tma || 0, plan.tma, `You pasted ${want} questions but only ${left} are left. `);

  const id = await jobs.enqueue(ctx().uid, 'tma', { material_id: row.id, tma_text: text });
  res.status(202).json({ job_id: id });
}));

jobs.register('tma', async (payload, emit) => {
  const text = String(payload.tma_text || '').trim().slice(0, 60000);
  const row = myMaterials().find(material => material.id === payload.material_id);
  if (!row) throw new Error('Go to Materials and upload your PDF first.');
  if (row.scanned) throw new Error('This PDF appears to be scanned/image-only. OCR is not available; upload a searchable PDF with selectable text.');
  const { plan, u } = limitsFor(ctx().uid);
  const requested = (E.extractTMA(text) || []).length;
  const left = plan.tma - (u.usage.tma || 0);
  if (requested > left) throw new Error(`Only ${Math.max(0, left)} TMA answers remain in your plan. Please shorten the request or upgrade.`);
  const result = await E.solveTMA({ row, text, groq, emit });
  let ent = HIST.get().find(h => h.material_id === row.id && h.user_id === ctx().uid);
  if (!ent) {
    ent = { material_id: row.id, user_id: ctx().uid, title: row.title, answers: [] };
    HIST.get().push(ent);
  }
  result.answers.forEach(answer => {
    const key = E.norm(answer.question || '');
    const index = ent.answers.findIndex(item => E.norm(item.question || '') === key);
    if (index >= 0) ent.answers[index] = answer;
    else ent.answers.push(answer);
  });
  ent.updated_at = new Date().toISOString();
  await HIST.save();
  const good = result.answers.filter(answer => answer.found !== false || answer.isGeneral).length;
  if (good) await bump(ctx().uid, 'tma', good);
  emit({ type: 'done', payload: {
    answers: result.answers, all_answers: ent.answers, new_count: result.answers.length, total_accumulated: ent.answers.length,
    not_found: result.answers.length - good, mode: result.mode, skipped: result.skipped || 0
  } });
});

app.get('/api/stats', (req, res) => {
  const mine = new Set(myMaterials().map(m => m.id)); const uid = ctx().uid; const { u } = limitsFor(uid);
  const hist = HIST.get().filter(h => h.user_id === uid);
  const quiz = CLOUD_DATA ? (ctx().quizzes || []) : rd(QUIZ_FILE, []).filter(q => q.user_id === uid);
  const tma = hist.reduce((a, h) => a + (h.answers || []).filter(x => x.found !== false && x.answer).length, 0);
  const pct = quiz.filter(q => q.total).map(q => q.score / q.total * 100);
  const sums = CLOUD_DATA ? (ctx().summaries || {}) : rd(SUM_FILE, {});
  res.json({
    materials: mine.size, tma_solved: tma, quizzes: u.usage.quiz || 0,
    ai_chats: u.usage.chat || 0,
    quiz_attempts: quiz.length,
    avg_score: pct.length ? Math.round(pct.reduce((a, b) => a + b, 0) / pct.length) : 0,
    summaries: [...mine].reduce((a, id) => a + Object.keys((sums[id] && sums[id].units) || {}).length, 0)
  });
});
app.post('/api/quiz/result', asyncHandler(async (req, res) => {
  const b = req.body || {}; const all = CLOUD_DATA ? (ctx().quizzes || []) : rd(QUIZ_FILE, []);
  if (!myMaterials().some(m => m.id === b.material_id)) return res.status(404).json({ error: 'Material not found' });
  const r = { id: Date.now().toString(36), user_id: ctx().uid, material_id: b.material_id, title: String(b.title || '').slice(0, 200), level: b.level || b.difficulty, score: +b.score || 0, total: +b.total || 0, by_level: b.by_level || null, at: Date.now() };
  all.push(r);
  if (CLOUD_DATA) {
    await cloudStore.upsert('cm_quiz_results', [{
      id: r.id, user_id: r.user_id, material_id: r.material_id, payload: r, created_at: new Date(r.at).toISOString()
    }], 'id');
  } else wr(QUIZ_FILE, all);
  res.json({ ok: true, result: r });
}));
app.get('/api/quiz/history/:id', (req, res) =>
  res.json({ results: (CLOUD_DATA ? (ctx().quizzes || []) : rd(QUIZ_FILE, []).filter(r => r.user_id === ctx().uid)).filter(r => r.material_id === req.params.id).sort((a, b) => b.at - a.at) }));
app.post('/api/quiz/clear', asyncHandler(async (req, res) => {
  if (CLOUD_DATA) {
    await cloudStore.remove('cm_quiz_results', { user_id: ctx().uid });
    ctx().quizzes.splice(0, ctx().quizzes.length);
  } else wr(QUIZ_FILE, rd(QUIZ_FILE, []).filter(r => r.user_id !== ctx().uid));
  res.json({ ok: true });
}));

app.post('/api/quiz/generate', aiRate, gate('quiz', 'quizzes'), countOnSuccess('quiz'));
app.post(['/api/tutor', '/api/chat'], aiRate, gate('chat', 'AI chats'), (req, res, next) => {
  if (req.body && !['unit', 'quizme'].includes(req.body.mode)) return countOnSuccess('chat')(req, res, next);
  next();
});
app.post(['/api/summary', '/api/summary/batch'], aiRate);

app.get('/api/summary/:id', (req, res, next) => myMaterials().some(m => m.id === req.params.id) ? next() : res.json({ units: {}, modules: {} }));

jobs.configure({
  runAsUser: async (userId, task) => {
    const response = await cloudStore.getAuthUser(userId);
    const authUser = response && (response.user || response);
    if (!authUser || authUser.id !== userId) throw new Error('The account for this task could not be verified. Please sign in again.');
    const confirmed = !!(authUser.email_confirmed_at || authUser.confirmed_at);
    const user = {
      id: authUser.id,
      email: authUser.email || '',
      name: (authUser.user_metadata && (authUser.user_metadata.full_name || authUser.user_metadata.name)) || '',
      admin: confirmed && ADMINS.includes(String(authUser.email || '').toLowerCase())
    };
    const data = await loadCloudRequestData(user);
    return als.run({ uid: user.id, user, ...data }, task);
  }
});

F.register(app, {
  groq,
  jobs,
  userId: () => ctx().uid,
  countUsage: kind => bump(ctx().uid, kind),
  ensureAllowance: kind => {
    const { plan, u } = limitsFor(ctx().uid);
    const used = u.usage[kind] || 0;
    if (used >= plan[kind]) {
      const label = kind === 'quiz' ? 'quizzes' : 'AI chats';
      throw new Error(`Plan limit reached (${used}/${plan[kind]} ${label}). Upgrade to Starter (N${STARTER_PRICE.toLocaleString()}/month) to continue.`);
    }
  },
  loadMaterials: () => myMaterials(),
  loadHistory: () => HIST.get().filter(h => h.user_id === ctx().uid),
  ...(CLOUD_DATA ? {
  loadSummary: id => ctx().summaries[String(id)] || null,
  saveSummary: async (id, payload) => {
    const userId = ctx().uid;
    ctx().summaries[String(id)] = payload;
    await cloudStore.upsert('cm_summaries', [{
      user_id: userId, material_id: String(id), payload, updated_at: new Date().toISOString()
    }], 'user_id,material_id');
  }
  } : {})
});

app.get('/api/jobs/:id', asyncHandler(async (req, res) => {
  if (!CLOUD_DATA) return res.status(503).json({ error: 'Background jobs require Supabase server storage.' });
  const job = await jobs.getJob(ctx().uid, req.params.id);
  if (!job) return res.status(404).json({ error: 'Task not found.' });
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  const rows = await jobs.eventsFor(ctx().uid, job.id, after);
  res.json({
    status: job.status,
    error: job.status === 'failed' ? job.error : null,
    events: rows.flatMap(row => Array.isArray(row.events) ? row.events : []),
    after: rows.length ? rows[rows.length - 1].seq : after
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 100MB).' });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  if (CLOUD_DATA) jobs.start();
  else console.warn('[ai-jobs] background AI jobs are disabled without Supabase server storage.');
  app.listen(PORT, () => {
    console.log(`\nCourseMate running on ${APP_URL}`);
    console.log(`  AI key:      ${GROQ_KEY ? 'set' : 'MISSING (add GROQ_API_KEY)'}`);
    console.log(`  Login check: ${REQUIRE_AUTH ? 'Supabase (on)' : 'OFF - local test mode only!'}`);
    console.log(`  Check AI:    ${APP_URL}/api/health?deep=1\n`);
  });
}
module.exports = { app, PLANS };