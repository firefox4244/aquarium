-- Живой аквариум: Supabase PostgreSQL + Auth + private Storage.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.aquariums (
  user_id uuid primary key references auth.users(id) on delete cascade,
  background text not null default 'neutral' check (background in ('neutral','ocean','freshwater','night','reef')),
  settings jsonb not null default '{"speed":1,"bubbles":true}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.fish (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Моя рыбка' check (char_length(name) between 1 and 80),
  object_key text not null unique,
  width integer not null check (width between 1 and 5000),
  height integer not null check (height between 1 and 5000),
  created_at timestamptz not null default now(),
  constraint fish_object_belongs_to_user check (split_part(object_key, '/', 1) = user_id::text)
);
create index if not exists fish_user_created_idx on public.fish(user_id, created_at);

create table if not exists public.decorations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('chest','coral','seaweed','statue','ruins','shell')),
  x double precision not null default 0.5 check (x between 0 and 1),
  y double precision not null default 0.82 check (y between 0 and 1),
  created_at timestamptz not null default now()
);
create index if not exists decorations_user_created_idx on public.decorations(user_id, created_at);

-- TV device tokens and one-time pairing codes are only accessed by the Edge Function / RPC.
create table if not exists public.tv_devices (
  device_token_hash text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create table if not exists public.tv_pair_codes (
  code_hash text primary key,
  device_token_hash text not null references public.tv_devices(device_token_hash) on delete cascade,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tv_pair_device_created_idx on public.tv_pair_codes(device_token_hash, created_at desc);

create table if not exists public.tv_pair_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0
);

-- Every new account receives an empty aquarium automatically.
create or replace function public.create_user_aquarium()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.aquariums(user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_aquarium on auth.users;
create trigger on_auth_user_created_aquarium after insert on auth.users
for each row execute function public.create_user_aquarium();

-- Enforce collection caps even if requests are made outside the website.
create or replace function public.enforce_aquarium_limits()
returns trigger language plpgsql set search_path = '' as $$
declare current_count integer;
begin
  if tg_table_name = 'fish' then
    select count(*) into current_count from public.fish where user_id = new.user_id;
    if current_count >= 100 then raise exception 'В аквариуме может быть не более 100 рыбок.'; end if;
  elsif tg_table_name = 'decorations' then
    select count(*) into current_count from public.decorations where user_id = new.user_id;
    if current_count >= 40 then raise exception 'В аквариуме может быть не более 40 декораций.'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists fish_collection_limit on public.fish;
create trigger fish_collection_limit before insert on public.fish for each row execute function public.enforce_aquarium_limits();
drop trigger if exists decorations_collection_limit on public.decorations;
create trigger decorations_collection_limit before insert on public.decorations for each row execute function public.enforce_aquarium_limits();

-- The six-digit code is hashed in both the Edge Function and this RPC.
create or replace function public.claim_tv_pair(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_device_hash text;
  v_expires timestamptz;
  v_claimed timestamptz;
  v_attempts integer;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'message', 'Сначала войди в аккаунт.'); end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' then return jsonb_build_object('ok', false, 'message', 'Код должен состоять из шести цифр.'); end if;
  insert into public.tv_pair_attempts(user_id, window_started_at, attempts) values (auth.uid(), now(), 1)
  on conflict (user_id) do update set
    window_started_at = case when public.tv_pair_attempts.window_started_at < now() - interval '10 minutes' then now() else public.tv_pair_attempts.window_started_at end,
    attempts = case when public.tv_pair_attempts.window_started_at < now() - interval '10 minutes' then 1 else public.tv_pair_attempts.attempts + 1 end
  returning attempts into v_attempts;
  if v_attempts > 10 then return jsonb_build_object('ok', false, 'message', 'Слишком много попыток. Подожди 10 минут и попробуй снова.'); end if;
  v_hash := encode(extensions.digest(convert_to(p_code, 'UTF8'), 'sha256'), 'hex');
  select device_token_hash, expires_at, claimed_at into v_device_hash, v_expires, v_claimed
    from public.tv_pair_codes where code_hash = v_hash for update;
  if v_device_hash is null then return jsonb_build_object('ok', false, 'message', 'Код не найден. Создай новый код на телевизоре.'); end if;
  if v_claimed is not null then return jsonb_build_object('ok', false, 'message', 'Этот код уже использован.'); end if;
  if v_expires <= now() then return jsonb_build_object('ok', false, 'message', 'Код истёк. Обнови его на телевизоре.'); end if;
  update public.tv_pair_codes set claimed_at = now() where code_hash = v_hash and claimed_at is null;
  if not found then return jsonb_build_object('ok', false, 'message', 'Этот код уже использован.'); end if;
  update public.tv_devices set owner_id = auth.uid(), last_seen_at = now() where device_token_hash = v_device_hash;
  return jsonb_build_object('ok', true, 'message', 'Телевизор подключён к твоему аквариуму.');
end;
$$;
revoke all on function public.claim_tv_pair(text) from public;
grant execute on function public.claim_tv_pair(text) to authenticated;

alter table public.aquariums enable row level security;
alter table public.fish enable row level security;
alter table public.decorations enable row level security;
alter table public.tv_devices enable row level security;
alter table public.tv_pair_codes enable row level security;
alter table public.tv_pair_attempts enable row level security;

drop policy if exists aquarium_owner_all on public.aquariums;
create policy aquarium_owner_all on public.aquariums for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists fish_owner_all on public.fish;
create policy fish_owner_all on public.fish for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists decorations_owner_all on public.decorations;
create policy decorations_owner_all on public.decorations for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- No client-facing policies for TV tables. The service-role Edge Function accesses them server-side.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fish-images', 'fish-images', false, 8388608, array['image/png'])
on conflict (id) do update set public = false, file_size_limit = 8388608, allowed_mime_types = array['image/png'];

drop policy if exists fish_images_owner_select on storage.objects;
create policy fish_images_owner_select on storage.objects for select to authenticated using (bucket_id = 'fish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists fish_images_owner_insert on storage.objects;
create policy fish_images_owner_insert on storage.objects for insert to authenticated with check (bucket_id = 'fish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists fish_images_owner_update on storage.objects;
create policy fish_images_owner_update on storage.objects for update to authenticated using (bucket_id = 'fish-images' and (storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id = 'fish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists fish_images_owner_delete on storage.objects;
create policy fish_images_owner_delete on storage.objects for delete to authenticated using (bucket_id = 'fish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
