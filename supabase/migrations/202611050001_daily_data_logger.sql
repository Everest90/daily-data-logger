create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_credentials (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  code_digest text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_access_attempts (
  device_id uuid not null,
  attempted_at timestamptz not null default now()
);

create index if not exists workspace_access_attempts_device_time_idx
  on public.workspace_access_attempts (device_id, attempted_at desc);

create table if not exists public.workspace_devices (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null,
  device_name text not null default 'Unknown device',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (workspace_id, device_id)
);

create table if not exists public.daily_entries (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  business_date date not null,
  depositor text not null check (length(trim(depositor)) > 0),
  label text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  deleted_at timestamptz
);

create index if not exists daily_entries_workspace_date_idx
  on public.daily_entries (workspace_id, business_date desc);

create table if not exists public.entry_items (
  id uuid primary key,
  entry_id uuid not null references public.daily_entries(id) on delete cascade,
  position integer not null default 0,
  type text not null check (type in ('Phone', 'Powerbank', 'Laptop', 'Others')),
  statement text not null check (statement in ('Charger', 'Cord', 'Adaptor', 'None')),
  detail text not null default '',
  payment text not null check (payment in ('Transfer', 'Cash', 'Credit', 'None', 'Not Yet')),
  collector text not null default '',
  checked_in boolean not null default false,
  completed boolean not null default false,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  deleted_at timestamptz,
  constraint entry_items_completed_time check (not completed or completed_at is not null)
);

create index if not exists entry_items_entry_position_idx
  on public.entry_items (entry_id, position);

create table if not exists public.sync_receipts (
  operation_id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null,
  result jsonb not null,
  applied_at timestamptz not null default now()
);

create or replace function public.is_active_workspace_device(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspace_devices d
    where d.workspace_id = target_workspace_id
      and d.device_id = auth.uid()
      and d.revoked_at is null
  );
$$;

revoke all on function public.is_active_workspace_device(uuid) from public;
grant execute on function public.is_active_workspace_device(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_credentials enable row level security;
alter table public.workspace_access_attempts enable row level security;
alter table public.workspace_devices enable row level security;
alter table public.daily_entries enable row level security;
alter table public.entry_items enable row level security;
alter table public.sync_receipts enable row level security;

create policy "Workspace devices can read workspaces"
  on public.workspaces for select to authenticated
  using (public.is_active_workspace_device(id));

create policy "Devices can read their own membership"
  on public.workspace_devices for select to authenticated
  using (device_id = auth.uid() and revoked_at is null);

create policy "Workspace devices can read entries"
  on public.daily_entries for select to authenticated
  using (public.is_active_workspace_device(workspace_id));

create policy "Workspace devices can read entry items"
  on public.entry_items for select to authenticated
  using (
    exists (
      select 1 from public.daily_entries e
      where e.id = entry_items.entry_id
        and public.is_active_workspace_device(e.workspace_id)
    )
  );

grant select on public.workspaces, public.workspace_devices,
  public.daily_entries, public.entry_items to authenticated;
revoke all on public.workspace_credentials, public.workspace_access_attempts,
  public.sync_receipts from anon, authenticated;
grant all on public.workspaces, public.workspace_credentials,
  public.workspace_devices, public.workspace_access_attempts to service_role;

create or replace function public.apply_entry_operation(
  p_operation_id uuid,
  p_workspace_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_action text,
  p_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_receipt public.sync_receipts%rowtype;
  current_entry public.daily_entries%rowtype;
  next_version integer;
  item_data jsonb;
  snapshot jsonb;
  result jsonb;
begin
  if auth.uid() is null or not public.is_active_workspace_device(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;

  select * into existing_receipt from public.sync_receipts
    where operation_id = p_operation_id;
  if found then
    if existing_receipt.workspace_id <> p_workspace_id
      or existing_receipt.device_id <> auth.uid() then
      raise exception 'Operation ID belongs to another device';
    end if;
    return existing_receipt.result;
  end if;

  if p_action not in ('upsert', 'delete') then
    raise exception 'Unsupported operation';
  end if;

  select * into current_entry from public.daily_entries
    where id = p_entry_id and workspace_id = p_workspace_id for update;

  if p_expected_version is null then
    if found then
      return jsonb_build_object('status', 'conflict', 'serverVersion', current_entry.version);
    end if;
    next_version := 1;
  else
    if not found or current_entry.version <> p_expected_version then
      return jsonb_build_object(
        'status', 'conflict',
        'serverVersion', case when found then current_entry.version else null end
      );
    end if;
    next_version := current_entry.version + 1;
  end if;

  if p_action = 'delete' then
    if not found then
      return jsonb_build_object('status', 'conflict', 'serverVersion', null);
    end if;
    update public.daily_entries set deleted_at = now(), updated_at = now(), version = next_version
      where id = p_entry_id;
  else
    if length(trim(coalesce(p_entry->>'depositor', ''))) = 0 then
      raise exception 'A depositor is required';
    end if;
    if jsonb_typeof(p_entry->'items') is distinct from 'array' then
      raise exception 'Entry items must be an array';
    end if;
    if jsonb_array_length(p_entry->'items') = 0 then
      raise exception 'At least one item is required';
    end if;

    if found then
      update public.daily_entries
        set business_date = (p_entry->>'date')::date,
            depositor = p_entry->>'depositor',
            label = p_entry->>'label',
            updated_at = now(),
            version = next_version,
            deleted_at = null
        where id = p_entry_id;
      update public.entry_items
        set deleted_at = now(), updated_at = now(), version = version + 1
        where entry_id = p_entry_id and deleted_at is null;
    else
      insert into public.daily_entries (
        id, workspace_id, business_date, depositor, label, created_at, updated_at, version
      ) values (
        p_entry_id, p_workspace_id, (p_entry->>'date')::date,
        p_entry->>'depositor', p_entry->>'label',
        coalesce((p_entry->>'createdAt')::timestamptz, now()), now(), next_version
      );
    end if;

    if exists (
      select 1 from public.entry_items existing_item
      where existing_item.id in (
        select (incoming.value->>'id')::uuid
        from jsonb_array_elements(p_entry->'items') as incoming(value)
      ) and existing_item.entry_id <> p_entry_id
    ) then
      raise exception 'An item ID cannot be moved between entries';
    end if;

    for item_data in select value from jsonb_array_elements(p_entry->'items')
    loop
      insert into public.entry_items (
        id, entry_id, position, type, statement, detail, payment, collector,
        checked_in, completed, completed_at, updated_at, version, deleted_at
      ) values (
        (item_data->>'id')::uuid, p_entry_id,
        coalesce((item_data->>'position')::integer, 0),
        item_data->>'type', item_data->>'statement',
        coalesce(item_data->>'detail', ''), item_data->>'payment',
        coalesce(item_data->>'collector', ''),
        coalesce((item_data->>'checkedIn')::boolean, false),
        coalesce((item_data->>'completed')::boolean, false),
        nullif(item_data->>'completedAt', '')::timestamptz,
        now(), 1, null
      )
      on conflict (id) do update set
        position = excluded.position,
        type = excluded.type,
        statement = excluded.statement,
        detail = excluded.detail,
        payment = excluded.payment,
        collector = excluded.collector,
        checked_in = excluded.checked_in,
        completed = excluded.completed,
        completed_at = excluded.completed_at,
        updated_at = now(),
        version = public.entry_items.version + 1,
        deleted_at = null;
    end loop;
  end if;

  select jsonb_build_object(
    'id', e.id,
    'workspaceId', e.workspace_id,
    'date', e.business_date,
    'createdAt', e.created_at,
    'updatedAt', e.updated_at,
    'depositor', e.depositor,
    'label', e.label,
    'version', e.version,
    'deletedAt', e.deleted_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'type', i.type, 'statement', i.statement,
        'detail', i.detail, 'payment', i.payment, 'collector', i.collector,
        'checkedIn', i.checked_in, 'completed', i.completed, 'completedAt', i.completed_at
      ) order by i.position)
      from public.entry_items i where i.entry_id = e.id and i.deleted_at is null
    ), '[]'::jsonb)
  ) into snapshot
  from public.daily_entries e where e.id = p_entry_id;

  result := jsonb_build_object(
    'status', 'applied',
    'version', (snapshot->>'version')::integer,
    'entry', snapshot
  );
  insert into public.sync_receipts (operation_id, workspace_id, device_id, result)
    values (p_operation_id, p_workspace_id, auth.uid(), result);
  return result;
end;
$$;

revoke all on function public.apply_entry_operation(uuid, uuid, uuid, integer, text, jsonb) from public;
grant execute on function public.apply_entry_operation(uuid, uuid, uuid, integer, text, jsonb) to authenticated;
