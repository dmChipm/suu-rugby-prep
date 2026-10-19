-- SUU Rugby Prep: shared data, permissions and sign-in rules.
-- Everyone on the People list can read everything. Admin roles can change lists, sheets and people.
-- Everyone else can only change Status, Date Completed and Other Notes on sheet tasks.

create table public.role_access (
  role text primary key check (role in ('Coach','President','Treasurer','Presidency Member','Team Member','Volunteer')),
  admin boolean not null default false
);

create table public.people (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  email text,
  phone text,
  role text not null references public.role_access(role),
  status text not null default 'Invited' check (status in ('Invited','Active')),
  invited date not null default current_date,
  user_id uuid references auth.users(id) on delete set null
);
create unique index people_email_key on public.people (lower(email)) where email is not null and email <> '';

create table public.masters (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  game_info boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.master_tasks (
  id text primary key default gen_random_uuid()::text,
  master_id text not null references public.masters(id) on delete cascade,
  text text not null,
  owner text not null default '',
  details text not null default '',
  links text not null default '',
  notes text not null default '',
  due_offset int,
  position int not null default 0
);
create index on public.master_tasks (master_id);

create table public.sheets (
  id text primary key default gen_random_uuid()::text,
  master_id text,
  master_name text not null,
  game_info boolean not null default true,
  opponent text not null default '',
  date date,
  label text not null default '',
  example boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.sheet_tasks (
  id text primary key default gen_random_uuid()::text,
  sheet_id text not null references public.sheets(id) on delete cascade,
  text text not null,
  owner text not null default '',
  details text not null default '',
  links text not null default '',
  notes text not null default '',
  due date,
  status text not null default 'Not Started' check (status in ('Not Started','In Progress','Blocked','On Hold','Complete')),
  completed date,
  done_by text,
  position int not null default 0
);
create index on public.sheet_tasks (sheet_id);

-- Who is signed in, and what they may do.
create function public.current_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.people p where lower(p.email) = public.current_email() and public.current_email() <> '')
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.people p join public.role_access r on r.role = p.role
    where lower(p.email) = public.current_email() and public.current_email() <> '' and r.admin
  )
$$;

-- Called after sign-in: marks the invite as accepted and returns the person's row.
create function public.claim_invite() returns public.people
language plpgsql security definer set search_path = '' as $$
declare me public.people;
begin
  update public.people set status = 'Active', user_id = auth.uid()
  where lower(email) = public.current_email() and public.current_email() <> ''
  returning * into me;
  return me;
end $$;

revoke execute on function public.claim_invite() from anon, public;
grant execute on function public.claim_invite() to authenticated;

-- Non-admins may only change status, completion and notes on a sheet task.
create function public.guard_sheet_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin() then return new; end if;
  if new.sheet_id is distinct from old.sheet_id or new.text is distinct from old.text or new.owner is distinct from old.owner
     or new.details is distinct from old.details or new.links is distinct from old.links or new.due is distinct from old.due
     or new.position is distinct from old.position then
    raise exception 'Only admins can change that part of a task';
  end if;
  return new;
end $$;
create trigger sheet_tasks_guard before update on public.sheet_tasks for each row execute function public.guard_sheet_task();

-- Row level security.
alter table public.role_access enable row level security;
alter table public.people enable row level security;
alter table public.masters enable row level security;
alter table public.master_tasks enable row level security;
alter table public.sheets enable row level security;
alter table public.sheet_tasks enable row level security;

do $$
declare t text;
begin
  foreach t in array array['role_access','people','masters','master_tasks','sheets','sheet_tasks'] loop
    execute format('create policy "members read" on public.%I for select to authenticated using (public.is_member())', t);
    execute format('create policy "admins insert" on public.%I for insert to authenticated with check (public.is_admin())', t);
    execute format('create policy "admins delete" on public.%I for delete to authenticated using (public.is_admin())', t);
    if t = 'sheet_tasks' then
      execute format('create policy "members update" on public.%I for update to authenticated using (public.is_member()) with check (public.is_member())', t);
    else
      execute format('create policy "admins update" on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    end if;
  end loop;
end $$;

-- Live updates so everyone sees changes as they happen.
alter publication supabase_realtime add table public.people, public.role_access, public.masters, public.master_tasks, public.sheets, public.sheet_tasks;

-- Supporting people (added later). See migration "supporters_and_hardening".
alter table public.sheet_tasks add column supporters text[] not null default '{}';
alter table public.master_tasks add column supporters text[] not null default '{}';
-- current_person_name() and an updated guard_sheet_task() let a task's owner change its supporters.
alter table public.people drop constraint people_status_check;
alter table public.people add constraint people_status_check check (status in ('Invited','Active','Inactive'));
-- is_member(), is_admin() and claim_invite() were updated to ignore deactivated ('Inactive') people.
alter table public.sheet_tasks add column master_task_id text references public.master_tasks(id) on delete set null;

-- Other Notes: a running log anyone on the team can add to.
create table public.task_notes (
  id text primary key default gen_random_uuid()::text,
  sheet_task_id text not null references public.sheet_tasks(id) on delete cascade,
  author text not null default '',
  author_email text not null default public.current_email(),
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.task_notes enable row level security;
create policy "members read" on public.task_notes for select to authenticated using (public.is_member());
create policy "members add" on public.task_notes for insert to authenticated with check (public.is_member() and author_email = public.current_email());
create policy "author or admin delete" on public.task_notes for delete to authenticated using (public.is_admin() or author_email = public.current_email());
alter table public.master_tasks add column optional boolean not null default false;
alter table public.master_tasks add column needs_confirmation boolean not null default false;
alter table public.sheet_tasks add column optional boolean not null default false;
alter table public.sheet_tasks add column confirmation text not null default '';
-- guard_sheet_task() also blocks non-admins from changing optional and master_task_id.
-- Developer role (admin by default).
alter table public.role_access drop constraint role_access_role_check;
alter table public.role_access add constraint role_access_role_check check (role in ('Developer','Coach','President','Treasurer','Presidency Member','Team Member','Volunteer'));
insert into public.role_access (role, admin) values ('Developer', true) on conflict (role) do nothing;

-- Documents: admins upload, everyone on the team can view and search. Files live in the private "documents" storage bucket (25 MB per file).
create table public.documents (
  id text primary key default gen_random_uuid()::text,
  name text not null, notes text not null default '', category text not null default '',
  file_path text not null, mime text not null default '', size bigint not null default 0,
  text_content text not null default '', uploaded_by text not null default '', created_at timestamptz not null default now()
);
-- RLS: members read; admins insert/update/delete. Matching policies on storage.objects for bucket 'documents'.

-- Document access tiers (1 Admin, 2 Developers, 3 Players, 4 Volunteers).
-- role_access.doc_tier: highest tier a role can read. documents.min_tier: the tier a document is shared down to (default 3).
-- my_doc_tier() returns 1 for admin-access people, else their role's doc_tier. doc_visible(t) = is_member() and my_doc_tier() <= t.
-- documents and storage.objects (bucket 'documents') select policies use doc_visible(min_tier). See run-in-sql-editor-document-tiers.sql.

-- Readiness rules: masters.rules and sheets.rules (jsonb). Keys: behindLate, behindCombo, behindBlocked, riskLate, riskBlocked, riskWarn (0 = off). A new sheet copies its master rules.

-- Projects (migration "projects"): projects and project_tasks tables. can_manage_projects() = admins, President, Presidency Member.
-- Managers insert/update/delete projects and add/remove tasks; members may update a project task's status, completion and notes (guard_project_task trigger).

-- Messages (migrations "messages" and "message_attachments"): conversations (member_ids text[]), messages (attachments jsonb), conversation_reads.
-- current_person_id() and in_conversation(id) limit every read and write to the people in that chat. Files go in the private "chat" bucket (50 MB each) at <conversation>/<message>/<file>.

-- Message reactions and replies (applied as migration message_reactions_replies):
--   messages.reply_to text  (id of the message being answered)
--   message_reactions(id = message_id:person_id, message_id -> messages on delete cascade, conversation_id -> conversations on delete cascade,
--                     person_id, emoji, created_at); one reaction per person per message.
--   RLS: chat members read; you add/change only your own reaction; you or an admin can remove it. Added to realtime.

-- Only admins remove tasks (migration only_admins_remove_project_tasks): project_tasks and projects
--   "managers delete" policies now use is_admin(). Sheets, sheet tasks and template tasks were already admin-only
--   for adding and deleting.

-- Subtasks, task files and helpers (migration subtasks_task_files_helpers):
--   sheet_tasks.subtasks/files and project_tasks.subtasks/files are jsonb (default []); project_tasks.supporters text[].
--   Subtask: {id, text, owner, done, by, files}. File: upload {id, name, path, mime, size, by, byId, at} or document link {id, docId, name, ...}.
--   Private bucket "task-files" (25 MB per file): team members read and upload; the uploader or an admin deletes.

-- Template subtasks (migration template_subtasks): master_tasks.subtasks jsonb [{id, text, owner}], copied onto each new sheet's task.

-- Archiving (migration archiving): archived_at timestamptz + archived_by text on sheets, sheet_tasks, projects, project_tasks.
--   Archived rows stay in the database; the app hides them from lists and progress and offers Restore.

-- Archiving documents (applied as migration archive_documents): archived documents stay in the table and storage,
-- hidden from the Documents list, search and the attach picker until an admin restores or deletes them.
alter table public.documents add column if not exists archived_at timestamptz, add column if not exists archived_by text default '';

-- People on a project (applied as migration project_members). The project owner or an admin picks them; task owners,
-- helpers and subtask owners are chosen from them in the app. The owner may update their own project row.
alter table public.projects add column if not exists members text[] not null default '{}';
create or replace function public.is_project_owner(lead text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(lead, '') <> '' and exists (select 1 from public.people p where lower(p.email) = public.current_email() and public.current_email() <> '' and p.status <> 'Inactive' and lower(trim(p.name)) = lower(trim(lead)))
$$;
create policy "owner updates" on public.projects for update using (public.is_project_owner(lead)) with check (public.is_project_owner(lead));

-- project_owner_tasks (applied): a project's owner (lead) can add tasks to their project.
-- create policy "owner inserts" on public.project_tasks for insert to authenticated
--   with check (exists (select 1 from public.projects pj where pj.id = project_id and public.is_project_owner(pj.lead)));

-- Task importance (migration task_importance): importance text '' | 'high' | 'crucial' on sheet_tasks, project_tasks
--   and master_tasks (copied onto new sheets). Trigger guard_task_importance lets only admins set or change it.

-- Push notifications (migration push_notifications): pg_net + pg_cron.
--   push_subscriptions(endpoint pk, person_id, p256dh, auth): one row per device; saved with rpc save_push_subscription.
--   Vault secrets vapid_public, vapid_private and notify_key; push_keys() hands them to the server only.
--   Statement triggers notify_assigned() on sheet_tasks / project_tasks post new owners to the "notify" edge function,
--   and cron job "task-reminders" (15:00 UTC daily) posts {"type":"reminders"}. Admins send messages through the same function.
-- Chat notifications (migration notify_messages): statement trigger notify_messages() on messages posts
--   {"type":"message","ids":[...]} to the notify function, which tells everyone else in the conversation.

-- Task timing and history (migrations task_completed_at, task_status_log, task_log_assignments):
--   completed_at timestamptz on sheet_tasks / project_tasks, stamped by trigger stamp_completed_at() when a task becomes Complete.
--   task_status_log(task_id, kind 'sheet'|'project', parent_id, task_text, event 'status'|'assigned', owner, from_status, to_status,
--   changed_by, changed_at), written by trigger log_task_status() on status/owner changes; only admins can read it.
--   The app's Analytics (admins) and Status log read it.

-- Notification center: a record of every notification sent to each person (written by the notify function).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  person_id text not null references public.people(id) on delete cascade,
  kind text not null default '',            -- assigned, reminder, message or admin
  title text not null default '',
  body text not null default '',
  delivered boolean not null default false, -- reached at least one of their devices
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_person_created on public.notifications (person_id, created_at desc);
alter table public.notifications enable row level security;
create policy "own notifications read" on public.notifications for select using (person_id = public.current_person_id());
create or replace function public.mark_notifications_read() returns void language sql security definer set search_path = ''
  as 'update public.notifications set read_at = now() where person_id = public.current_person_id() and read_at is null';
revoke all on function public.mark_notifications_read() from public, anon;
grant execute on function public.mark_notifications_read() to authenticated;
alter table public.project_tasks add column if not exists optional boolean not null default false;

-- Calendar subscriptions: one private token per person; the calendar edge function serves their feed at ?t=<token>.
create table if not exists public.calendar_feeds (person_id text primary key references public.people(id) on delete cascade, token text not null unique default encode(gen_random_bytes(18), 'hex'), created_at timestamptz not null default now());
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;
create or replace function public.my_calendar_token(p_reset boolean default false) returns text language plpgsql security definer set search_path = public, extensions as '
declare me text := public.current_person_id(); tok text;
begin
  if me is null then raise exception ''not signed in''; end if;
  if p_reset then delete from public.calendar_feeds where person_id = me; end if;
  insert into public.calendar_feeds(person_id) values (me) on conflict (person_id) do nothing;
  select token into tok from public.calendar_feeds where person_id = me;
  return tok;
end';
revoke all on function public.my_calendar_token(boolean) from public, anon;
grant execute on function public.my_calendar_token(boolean) to authenticated;

-- AI assistant connector (edge function "mcp", verify_jwt off): a remote MCP server for Claude, ChatGPT and other clients.
--   It signs people in with Supabase Auth's OAuth 2.1 server (Authentication > OAuth Server: enabled, dynamic client registration on,
--   authorization path pointing at the app, which shows the Allow screen for ?authorization_id=). Every query runs with the person's
--   own token, so the policies above decide what an assistant can see and change.
