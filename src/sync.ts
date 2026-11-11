import { database, pendingCount } from "./database";
import { getSupabase } from "./supabase";
import type { LogRecord, OutboxOperation, Payment, RecordItem, Workspace } from "./types";

type ServerItem = {
  id: string;
  position: number;
  type: string;
  statement: string;
  detail: string;
  payment: Payment;
  collector: string;
  checked_in: boolean;
  checkedIn?: boolean;
  completed: boolean;
  completed_at: string | null;
  completedAt?: string | null;
  deleted_at: string | null;
};

type ServerRecord = {
  id: string;
  workspace_id: string;
  business_date: string;
  created_at: string;
  updated_at: string;
  depositor: string;
  label: string;
  version: number;
  deleted_at: string | null;
  entry_items: ServerItem[];
};

type AppliedEntry = {
  id: string;
  workspaceId: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  depositor: string;
  label: string;
  version: number;
  deletedAt: string | null;
  items: RecordItem[];
};

type ApplyResult =
  | { status: "applied"; version: number; entry: AppliedEntry }
  | { status: "conflict"; serverVersion: number | null };

const itemTypes = ["Phone", "Powerbank", "Laptop", "Others"];
const statements = ["Charger", "Cord", "Adaptor", "None"];
const payments = ["Transfer", "Cash", "Credit", "None", "Not Yet"];

function isPayment(value: unknown): value is Payment {
  return typeof value === "string" && payments.includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function parseServerItem(value: unknown): ServerItem {
  if (!isObject(value) ||
    typeof value.id !== "string" || !value.id ||
    !Number.isInteger(value.position) ||
    typeof value.type !== "string" || !itemTypes.includes(value.type) ||
    typeof value.statement !== "string" || !statements.includes(value.statement) ||
    typeof value.detail !== "string" ||
    !isPayment(value.payment) ||
    typeof value.collector !== "string" ||
    typeof value.checked_in !== "boolean" ||
    typeof value.completed !== "boolean" ||
    !isNullableTimestamp(value.completed_at) ||
    !isNullableTimestamp(value.deleted_at)) {
    throw new Error("The server returned an invalid workspace item.");
  }
  return {
    id: value.id,
    position: Number(value.position),
    type: value.type,
    statement: value.statement,
    detail: value.detail,
    payment: value.payment,
    collector: value.collector,
    checked_in: value.checked_in,
    completed: value.completed,
    completed_at: value.completed_at,
    deleted_at: value.deleted_at,
  };
}

function isRecordItem(value: unknown): value is RecordItem {
  if (!isObject(value)) return false;
  return typeof value.id === "string" && !!value.id &&
    typeof value.type === "string" && itemTypes.includes(value.type) &&
    typeof value.statement === "string" && statements.includes(value.statement) &&
    typeof value.detail === "string" &&
    isPayment(value.payment) &&
    typeof value.collector === "string" &&
    typeof value.checkedIn === "boolean" &&
    typeof value.completed === "boolean" &&
    typeof value.completedAt === "string" &&
    (!value.completedAt || isTimestamp(value.completedAt));
}

function parseAppliedItem(value: unknown): RecordItem {
  if (!isObject(value) ||
    typeof value.id !== "string" || !value.id ||
    typeof value.type !== "string" || !itemTypes.includes(value.type) ||
    typeof value.statement !== "string" || !statements.includes(value.statement) ||
    typeof value.detail !== "string" ||
    !isPayment(value.payment) ||
    typeof value.collector !== "string" ||
    typeof value.checkedIn !== "boolean" ||
    typeof value.completed !== "boolean" ||
    !isNullableStringValue(value.completedAt) ||
    (value.completedAt !== null && value.completedAt !== "" && !isTimestamp(value.completedAt))) {
    throw new Error("The server returned an invalid item in its sync confirmation.");
  }
  const item: RecordItem = {
    id: value.id,
    type: value.type,
    statement: value.statement,
    detail: value.detail,
    payment: value.payment,
    collector: value.collector,
    checkedIn: value.checkedIn,
    completed: value.completed,
    completedAt: value.completedAt ?? "",
  };
  if (!isRecordItem(item) || (item.completed && !item.completedAt)) {
    throw new Error("The server returned an inconsistent item in its sync confirmation.");
  }
  return item;
}

function isNullableStringValue(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseServerRecord(value: unknown): ServerRecord {
  if (!isObject(value) ||
    typeof value.id !== "string" || !value.id ||
    typeof value.workspace_id !== "string" || !value.workspace_id ||
    typeof value.business_date !== "string" ||
    !isTimestamp(value.created_at) || !isTimestamp(value.updated_at) ||
    typeof value.depositor !== "string" || !value.depositor.trim() ||
    typeof value.label !== "string" ||
    !Number.isInteger(value.version) || Number(value.version) < 1 ||
    !isNullableTimestamp(value.deleted_at) ||
    !Array.isArray(value.entry_items)) {
    throw new Error("The server returned an invalid workspace record.");
  }
  return {
    id: value.id,
    workspace_id: value.workspace_id,
    business_date: value.business_date,
    created_at: value.created_at,
    updated_at: value.updated_at,
    depositor: value.depositor,
    label: value.label,
    version: Number(value.version),
    deleted_at: value.deleted_at,
    entry_items: value.entry_items.map(parseServerItem),
  };
}

function parseApplyResult(value: unknown): ApplyResult {
  if (!isObject(value)) throw new Error("The server returned an invalid sync response.");
  const conflictVersion = value.serverVersion;
  if (value.status === "conflict" &&
    (conflictVersion === null || (typeof conflictVersion === "number" && Number.isInteger(conflictVersion)))) {
    return { status: "conflict", serverVersion: conflictVersion };
  }
  if (value.status !== "applied" || !Number.isInteger(value.version) || !isObject(value.entry)) {
    throw new Error("The server returned an incomplete sync confirmation.");
  }
  const entry = value.entry;
  if (typeof entry.id !== "string" || typeof entry.workspaceId !== "string" ||
    typeof entry.date !== "string" ||
    !isTimestamp(entry.createdAt) || !isTimestamp(entry.updatedAt) ||
    typeof entry.depositor !== "string" || !entry.depositor.trim() ||
    typeof entry.label !== "string" ||
    !Number.isInteger(entry.version) || !isNullableTimestamp(entry.deletedAt) ||
    !Array.isArray(entry.items)) {
    throw new Error("The server returned an invalid synced record.");
  }
  const items = entry.items.map(parseAppliedItem);
  return {
    status: "applied",
    version: Number(value.version),
    entry: {
      id: entry.id,
      workspaceId: entry.workspaceId,
      date: entry.date,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      depositor: entry.depositor,
      label: entry.label,
      version: Number(entry.version),
      deletedAt: entry.deletedAt,
      items,
    },
  };
}

async function ensureAnonymousSession(): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  if (session) return;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(error.message);
}

export async function accessWorkspace(
  action: "create" | "join",
  values: { code: string; workspaceName?: string; timezone?: string },
): Promise<Workspace> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Set the Supabase URL and anon key in .env.local first.");
  await ensureAnonymousSession();
  const { data, error } = await supabase.functions.invoke<unknown>("workspace-access", {
    body: { action, ...values, deviceName: `${navigator.platform || "Browser"} device` },
  });
  if (error) throw new Error(error.message);
  if (!isObject(data)) throw new Error("Workspace access returned an invalid response.");
  if (typeof data.error === "string") throw new Error(data.error);
  if (!isObject(data.workspace) ||
    typeof data.workspace.id !== "string" || !data.workspace.id ||
    typeof data.workspace.name !== "string" ||
    typeof data.workspace.timezone !== "string") {
    throw new Error("Workspace access returned an invalid response.");
  }
  return {
    id: data.workspace.id,
    name: data.workspace.name,
    timezone: data.workspace.timezone,
  };
}

function toLogRecord(record: ServerRecord): LogRecord {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    date: record.business_date,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    depositor: record.depositor,
    label: record.label,
    serverVersion: record.version,
    syncState: "synced",
    deletedAt: record.deleted_at,
    items: [...record.entry_items]
      .filter((item) => !item.deleted_at)
      .sort((left, right) => left.position - right.position)
      .map((item) => ({
        id: item.id,
        type: item.type,
        statement: item.statement,
        detail: item.detail ?? "",
        payment: item.payment,
        collector: item.collector ?? "",
        checkedIn: Boolean(item.checkedIn ?? item.checked_in),
        completed: Boolean(item.completed),
        completedAt: item.completedAt ?? item.completed_at ?? "",
      })),
  };
}

function toServerRecord(record: LogRecord) {
  return {
    date: record.date,
    createdAt: record.createdAt,
    depositor: record.depositor,
    label: record.label,
    items: record.items.map((item, position) => ({
      id: item.id,
      position,
      type: item.type,
      statement: item.statement,
      detail: item.detail,
      payment: item.payment,
      collector: item.collector,
      checkedIn: item.checkedIn,
      completed: item.completed,
      completedAt: item.completedAt || null,
    })),
  };
}

async function applyOperation(operation: OutboxOperation, record: LogRecord): Promise<ApplyResult> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("apply_entry_operation", {
    p_operation_id: operation.operationId,
    p_workspace_id: operation.workspaceId,
    p_entry_id: operation.entryId,
    p_expected_version: operation.expectedVersion,
    p_action: operation.action,
    p_entry: toServerRecord(record),
  });
  if (error) throw new Error(error.message);
  const result = parseApplyResult(data);
  if (result.status === "applied" &&
    (result.entry.id !== operation.entryId || result.entry.workspaceId !== operation.workspaceId ||
      result.entry.version !== result.version)) {
    throw new Error("The server returned a sync confirmation for a different record.");
  }
  return result;
}

async function loadConflictSnapshot(workspaceId: string, entryId: string): Promise<LogRecord | null> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("daily_entries")
    .select("id, workspace_id, business_date, created_at, updated_at, depositor, label, version, deleted_at, entry_items(id, position, type, statement, detail, payment, collector, checked_in, completed, completed_at, deleted_at)")
    .eq("workspace_id", workspaceId)
    .eq("id", entryId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const record = parseServerRecord(data);
  if (record.workspace_id !== workspaceId || record.id !== entryId) {
    throw new Error("The server returned a conflict record for a different workspace entry.");
  }
  return toLogRecord(record);
}

export async function syncWorkspace(workspace: Workspace): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Supabase is not configured.");
  if (!navigator.onLine) throw new Error("You are offline. Changes remain saved on this device.");

  const { data: membership, error: membershipError } = await supabase
    .from("workspace_devices")
    .select("workspace_id")
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (membershipError) throw new Error(`Workspace authorization failed: ${membershipError.message}`);
  if (!membership) throw new Error("This device is no longer authorized for the workspace.");

  const operations = await database.outbox.where("workspaceId").equals(workspace.id).sortBy("createdAt");
  for (const operation of operations) {
    const record = await database.entries.get(operation.entryId);
    if (!record) {
      await database.outbox.delete(operation.operationId);
      continue;
    }

    try {
      const result = await applyOperation(operation, record);
      if (result.status === "conflict") {
        const conflictSnapshot = await loadConflictSnapshot(workspace.id, record.id);
        await database.entries.update(record.id, { syncState: "conflict", conflictSnapshot });
        continue;
      }
      if (result.status !== "applied" || !result.entry || typeof result.version !== "number") {
        throw new Error("The server returned an incomplete sync confirmation.");
      }
      const appliedVersion = result.version;
      const appliedEntry = result.entry;

      await database.transaction("rw", database.entries, database.outbox, async () => {
        const latest = await database.entries.get(record.id);
        const changedDuringSync = latest && (
          latest.updatedAt !== record.updatedAt ||
          latest.deletedAt !== record.deletedAt ||
          JSON.stringify(latest.items) !== JSON.stringify(record.items)
        );
        if (changedDuringSync && latest) {
          await database.entries.update(record.id, {
            serverVersion: appliedVersion,
            syncState: "pending",
            conflictSnapshot: null,
          });
          const queued = await database.outbox.get(operation.operationId);
          if (queued) {
            await database.outbox.put({
              ...queued,
              operationId: crypto.randomUUID(),
              action: latest.deletedAt ? "delete" : "upsert",
              expectedVersion: appliedVersion,
              createdAt: new Date().toISOString(),
            });
            await database.outbox.delete(operation.operationId);
          }
        } else {
          await database.entries.put({
            ...appliedEntry,
            serverVersion: appliedVersion,
            syncState: "synced",
            conflictSnapshot: null,
          });
          await database.outbox.delete(operation.operationId);
        }
      });
    } catch (error) {
      await database.outbox.update(operation.operationId, {
        error: error instanceof Error ? error.message : "Sync failed.",
      });
      await database.entries.update(record.id, { syncState: "failed" });
      throw error;
    }
  }

  let afterId: string | null = null;
  while (true) {
    let query = supabase
      .from("daily_entries")
      .select("id, workspace_id, business_date, created_at, updated_at, depositor, label, version, deleted_at, entry_items(id, position, type, statement, detail, payment, collector, checked_in, completed, completed_at, deleted_at)")
      .eq("workspace_id", workspace.id)
      .order("id", { ascending: true })
      .limit(500);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    for (const row of data) {
      afterId = row.id;
      const pending = await database.outbox.where("entryId").equals(row.id).first();
      if (pending) continue;
      const parsed = parseServerRecord(row);
      if (parsed.workspace_id !== workspace.id) {
        throw new Error("The server returned a record from a different workspace.");
      }
      const remote = toLogRecord(parsed);
      const existing = await database.entries.get(remote.id);
      if (existing?.syncState === "conflict") {
        await database.entries.update(remote.id, { conflictSnapshot: remote });
      } else if (!existing || existing.serverVersion === null || existing.serverVersion <= remote.serverVersion!) {
        await database.entries.put(remote);
      }
    }
    if (data.length < 500) break;
  }

  const remaining = await pendingCount(workspace.id);
  if (remaining > 0) throw new Error(`${remaining} change(s) still need attention.`);
}

export async function resolveConflict(record: LogRecord, choice: "local" | "server"): Promise<void> {
  if (choice === "server") {
    await database.transaction("rw", database.entries, database.outbox, async () => {
      if (record.conflictSnapshot) await database.entries.put(record.conflictSnapshot);
      else await database.entries.delete(record.id);
      const queued = await database.outbox.where("entryId").equals(record.id).first();
      if (queued) await database.outbox.delete(queued.operationId);
    });
    return;
  }

  if (!record.workspaceId) throw new Error("The conflicted record has no workspace.");
  const serverVersion = record.conflictSnapshot?.serverVersion ?? null;
  if (serverVersion === null && !record.conflictSnapshot && record.deletedAt) {
    await database.transaction("rw", database.entries, database.outbox, async () => {
      await database.entries.delete(record.id);
      const queued = await database.outbox.where("entryId").equals(record.id).first();
      if (queued) await database.outbox.delete(queued.operationId);
    });
    return;
  }
  if (serverVersion === null && !record.conflictSnapshot && !record.deletedAt) {
    const recreated: LogRecord = {
      ...record,
      id: crypto.randomUUID(),
      items: record.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
      serverVersion: null,
      syncState: "pending",
      deletedAt: null,
      conflictSnapshot: null,
      updatedAt: new Date().toISOString(),
    };
    await database.transaction("rw", database.entries, database.outbox, async () => {
      await database.entries.delete(record.id);
      const queued = await database.outbox.where("entryId").equals(record.id).first();
      if (queued) await database.outbox.delete(queued.operationId);
    });
    await database.entries.put(recreated);
    await database.outbox.put({
      operationId: crypto.randomUUID(),
      entryId: recreated.id,
      workspaceId: record.workspaceId,
      action: "upsert",
      expectedVersion: null,
      createdAt: new Date().toISOString(),
    });
    return;
  }

  await database.transaction("rw", database.entries, database.outbox, async () => {
    await database.entries.update(record.id, {
      serverVersion,
      syncState: "pending",
      conflictSnapshot: null,
      updatedAt: new Date().toISOString(),
    });
    const operation = await database.outbox.where("entryId").equals(record.id).first();
    if (operation) {
      await database.outbox.update(operation.operationId, {
        expectedVersion: serverVersion,
        action: record.deletedAt ? "delete" : "upsert",
        error: undefined,
      });
    }
  });
}
