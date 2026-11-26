-- One row of per-user app settings (Dynalist file id and API token for the embed).
create table settings (
  user_id uuid primary key default auth.uid() references auth.users(id),
  dynalist_file_id text,
  dynalist_token text
);
alter table settings enable row level security;
create policy "own settings" on settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
