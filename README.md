# COURSE-MATE

## Long-running AI tasks

Summary, Quiz, Tutor, and TMA requests run as Supabase-backed background jobs. The API returns a task ID promptly, and the site polls for progress and the final result instead of holding one HTTP request open while Groq works. This avoids gateway request timeouts for these features, but does not remove Render, Supabase, or AI-provider availability and resource limits.

The Groq SDK request timeout is set to 10 minutes by default (its SDK default is 1 minute); `GROQ_REQUEST_TIMEOUT_MS` can override it with a positive integer. This applies to work inside the background worker, not the short browser/API submission request.

Before deploying this change:

1. Run the updated `supabase/schema.sql` in the Supabase SQL editor. It creates the AI job queue and atomic job-claim function.
2. Deploy the updated Node server to Render. The existing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, and `GROQ_API_KEY` server environment variables are required.
3. Deploy the matching site files so Summary, Quiz, Tutor, and TMA can submit jobs and poll `/api/jobs/:id`.

The Render process starts its queue worker automatically when Supabase server storage is configured. Keep the Supabase service-role key on the server only; never put it in browser code.