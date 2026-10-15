-- CourseMate's private application data. Run this in the Supabase SQL editor.
-- The server uses the service-role key; never expose it to browser code.

create table if not exists public.cm_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.cm_materials (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cm_materials_user_id_idx on public.cm_materials(user_id);

create table if not exists public.cm_tma_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  material_id text not null references public.cm_materials(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, material_id)
);

create table if not exists public.cm_quiz_results (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  material_id text not null references public.cm_materials(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cm_quiz_results_user_material_idx
  on public.cm_quiz_results(user_id, material_id);

create table if not exists public.cm_summaries (
  user_id uuid not null references auth.users(id) on delete cascade,
  material_id text not null references public.cm_materials(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, material_id)
);

create table if not exists public.cm_payment_submissions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt_path text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cm_payment_submissions_user_id_idx
  on public.cm_payment_submissions(user_id);
create unique index if not exists cm_payment_one_pending_per_user_idx
  on public.cm_payment_submissions(user_id)
  where payload->>'status' = 'pending';
create unique index if not exists cm_payment_activation_code_idx
  on public.cm_payment_submissions((payload->>'code'))
  where coalesce(payload->>'code', '') <> '';

alter table public.cm_user_state enable row level security;
alter table public.cm_materials enable row level security;
alter table public.cm_tma_history enable row level security;
alter table public.cm_quiz_results enable row level security;
alter table public.cm_summaries enable row level security;
alter table public.cm_payment_submissions enable row level security;

-- No client policies are intentional: all data access is performed by the
-- authenticated application server with its server-side service-role key.
revoke all on public.cm_user_state, public.cm_materials, public.cm_tma_history,
  public.cm_quiz_results, public.cm_summaries, public.cm_payment_submissions
  from anon, authenticated;
grant all on public.cm_user_state, public.cm_materials, public.cm_tma_history,
  public.cm_quiz_results, public.cm_summaries, public.cm_payment_submissions
  to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('coursemate-files', 'coursemate-files', false, 104857600, array['application/pdf']),
       ('coursemate-receipts', 'coursemate-receipts', false, 8388608,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
