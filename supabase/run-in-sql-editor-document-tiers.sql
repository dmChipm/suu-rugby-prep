-- Document access tiers: paste into Supabase > SQL Editor and press Run.
update public.role_access set doc_tier = case role when 'Developer' then 2 when 'Coach' then 1 when 'President' then 1 when 'Volunteer' then 4 else 3 end;
drop policy if exists "members read" on public.documents;
create policy "members read by tier" on public.documents for select to authenticated using (public.doc_visible(min_tier));
drop policy if exists "team reads documents" on storage.objects;
create policy "team reads documents by tier" on storage.objects for select to authenticated using (
  bucket_id = 'documents' and exists (select 1 from public.documents d where d.file_path = storage.objects.name and public.doc_visible(d.min_tier)));
