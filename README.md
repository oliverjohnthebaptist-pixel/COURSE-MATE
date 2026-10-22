# CourseMate v1 - setup guide

## 1. Run it on your computer
```
npm install
copy .env.example .env      (Mac/Linux: cp .env.example .env)   then fill GROQ_API_KEY
npm start
```
Open http://localhost:3000 . Check the AI is alive: http://localhost:3000/api/health?deep=1  ->  `"ai_live": true`.
If it says false, the message tells you why (busy / wrong key / model not available).

## 2. Groq - the most important thing for your summaries
* Groq switched off llama-3.1-8b, llama-3.3-70b and qwen3-32b in 2026. Using them gives **error 404**. This version uses
  `openai/gpt-oss-20b` and `openai/gpt-oss-120b` (set in `AI_MODELS`).
* The FREE Groq plan allows only ~8,000 tokens per minute and 200,000 per day for the WHOLE website, and a full course summary
  needs about 150,000 tokens. That is why summaries "hit a reset time". For real students you need the **Developer plan**
  (add a card in Groq). A whole course then costs only a few cents and takes minutes, not hours.
  After upgrading, uncomment the 4 speed lines in `.env` (GROQ_TPM, GROQ_RPM, AI_CONCURRENCY, SUMMARY_POOL).

## 3. Supabase and Vercel
The project now has a Vercel Express entry point and Supabase-backed API data/storage paths. Do not deploy until the
existing data import has completed and a live smoke test has passed. Vercel's local disk is temporary; production mode
requires Supabase server storage and does not use a persistent disk.

The Supabase schema is in `supabase/schema.sql`. It creates private tables and private storage buckets; the browser is
not given table access. For the one-time import, set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the local project
environment, then run `npm run migrate:check` followed by `npm run migrate:supabase`. Never use the publishable/anon
key as the service key, and never put the service key in browser code or commit it.

The importer is repeatable: it upserts records and overwrites matching storage objects. It reads JSON records from
`data/`, merges legacy-only summaries and quiz results from the project root without overwriting newer `data/` records,
and reads files from `uploads/` and `data/payment-evidence/` (or under `COURSEMATE_STORAGE_DIR` when set). Supabase Auth
users referenced by the JSON files must already exist with the same UUID. Keep a backup of the local folders and do not
delete them after import.

For Vercel, configure `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `GROQ_API_KEY`,
`APP_URL` (the final HTTPS domain), and `ADMIN_EMAILS` in Project Settings > Environment Variables. The `vercel.json`
function limit is 60 seconds. Large summaries may outlast that limit; run a real summary smoke test before launch and use
a background-job worker if the deployment plan cannot support the required duration. Do not upload `.env` to Vercel or
GitHub.

## 4. Continue with Google (sign up / sign in with one click)
1. Google Cloud Console > APIs & Services > Credentials > Create credentials > OAuth client ID > Web application.
   Authorised redirect URI: `https://lohjifbvrbnqxamroxtp.supabase.co/auth/v1/callback`
2. Supabase dashboard > Authentication > Providers > Google: switch on, paste the Client ID and Client Secret.
3. Supabase > Authentication > URL Configuration: Site URL = your live address; add Redirect URL `https://YOUR-SITE/dashboard.html`
   (and `http://localhost:3000/dashboard.html` for testing).
4. If your `profiles` table uses Row Level Security, allow a person to create their own row:
   `create policy "own profile insert" on profiles for insert with check (auth.uid() = id);`

## 5. Starter payment by bank transfer
The pricing page links to the separate **Starter payment** page, which displays the transfer details: OPAY, account name
**NGWOUKE OLIVER**, account number **7067159305**. Students transfer **₦4,500**, sign in, and upload only their payment
receipt on that page. That same page is where students enter activation codes. After checking the transfer, an administrator
opens **Payment review** from the dashboard, views the receipt inline, and generates an account-bound code in the format
`CM-XXXX-2026`. The student enters that code on the Starter payment page to activate Starter for 30 days. Codes can only be
redeemed once, and only by the account that submitted the payment evidence.

Set the reviewing administrator's confirmed login email in `ADMIN_EMAILS` (comma-separated) in the server environment.
On Vercel, receipts are stored in the private `coursemate-receipts` Supabase bucket and payment review issues a short-lived
signed preview URL only after administrator authentication. Local development stores receipts under `data/payment-evidence/`.

## Netlify frontend + Render API

The Express API and long-running AI summary routes should run as a persistent Node service, not a Netlify Function.
Use Netlify for the static website and Render for the API:

1. Create a Render **Web Service** from the same GitHub repository and set its **Root Directory** to `coursemate`
   (or the directory containing this README and `server.js`). Use `npm install` for the build command and `npm start`
   for the start command. Select Node 18 or newer.
2. Set these Render environment variables: `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_KEY`, `GROQ_API_KEY`, `APP_URL` (the final Netlify HTTPS site URL), and `ADMIN_EMAILS`.
   To deliver feedback by email, also set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to a verified Resend sender.
   Feedback is sent to every address in `ADMIN_EMAILS`; if that list is empty, it goes to
   `oliverjohnthebaptist@gmail.com`.
   Finish the Supabase data import and test the service at `/api/health?deep=1` before launch. Do not upload `.env`
   to Render or GitHub.
3. In Netlify, select the repository and set **Base directory** to `coursemate` (or the directory containing this
   README and `package.json`). The build command and publish directory are defined in `netlify.toml`.
4. After Render creates the API service, replace `YOUR-RENDER-SERVICE` in `netlify.toml` with the Render service's
   hostname (for example, `coursemate-api`), then push the change so Netlify redeploys.
5. Set `APP_URL` on Render to the Netlify URL, and add the Netlify URL to Supabase Authentication's Site URL and
   Redirect URLs.

The Netlify build copies only public website files into `dist`; it does not publish `.env`, local data, or uploaded
files. The API remains responsible for authentication, storage, AI, and payments.

## 6. Owner access
Put your login email in `ADMIN_EMAILS`. That account gets unlimited PDFs, TMA, chats and quizzes. It is not shown anywhere on the site.
Sign up with that email first and confirm it, so nobody else can register it.

## Rules built in
Free: 3 PDFs, 15 TMA answers, 20 AI chats, 20 quizzes. Starter: 7 PDFs, 70 TMA, unlimited chats, 100 quizzes.
Materials cannot be deleted once uploaded. The same PDF cannot be uploaded twice by one student.
Each student only sees their own PDFs, answers, summaries and quizzes.


## v2 notes (read this)
**AI models.** Groq shut down llama-3.3-70b, llama-3.1-8b and qwen3-32b in 2026; they answer "404". The app now uses
`openai/gpt-oss-20b` and `openai/gpt-oss-120b`. Delete any old `TMA_MODEL` line from your `.env`.

**Speed and Groq plans.** Summaries read every page of every unit, so they use many tokens (roughly 100k-400k per course).
Groq's free tier allows only about 8,000 tokens per minute (and a daily cap), so one big course can take 25+ minutes and
you may only finish about one course a day. For paying students, switch your Groq account to the Developer (pay-as-you-go)
plan and set `GROQ_PLAN=developer`. Check current limits at console.groq.com/settings/limits.
If the AI is busy, students see "The AI is busy ... try again in N seconds", never a bare 404.

**Summaries.** Tick up to 5 courses on the Summary page to summarise them together. Failed units are retried automatically.

**Owner access.** Put your own email in `ADMIN_EMAILS`, sign up with it and confirm it. You get unlimited features. Nothing on the
site mentions this. Do it before launch so nobody else can register your email first.

**Materials cannot be deleted.** By design. Re-uploading the same PDF is rejected as a duplicate.

**PDFs.** Use searchable PDFs with selectable text for study features. Scanned/image-only PDFs are not currently rasterized for OCR; the TMA solver rejects detected scanned PDFs with an explicit error.

**Sign in with Google (the "Continue with Gmail" button).** Switch it on once:
1. Google Cloud Console > APIs & Services > Credentials > Create OAuth client ID > Web application.
   Authorised redirect URI: `https://lohjifbvrbnqxamroxtp.supabase.co/auth/v1/callback`
2. Supabase dashboard > Authentication > Providers > Google: enable it and paste the Client ID and Client Secret.
3. Supabase > Authentication > URL Configuration: set Site URL to your live address and add `https://YOUR-SITE/dashboard.html` to Redirect URLs.
