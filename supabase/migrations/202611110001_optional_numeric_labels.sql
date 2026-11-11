do $$
declare
  function_definition text;
  updated_definition text;
begin
  select pg_get_functiondef(
    'public.apply_entry_operation(uuid, uuid, uuid, integer, text, jsonb)'::regprocedure
  ) into function_definition;

  updated_definition := regexp_replace(
    function_definition,
    $pattern$or[[:space:]]+length\(trim\(coalesce\(p_entry->>'label', ''\)\)\) = 0$pattern$,
    'false'
  );

  if updated_definition <> function_definition then
    execute updated_definition;
  end if;
end;
$$;

alter table public.daily_entries
  drop constraint if exists daily_entries_label_check;
