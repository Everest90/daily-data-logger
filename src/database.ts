import Dexie, { type Table } from "dexie";
import type { LogRecord, OutboxOperation } from "./types";

const MIGRATION_KEY = "localStorageMigration.v1";
const LEGACY_STORAGE_KEY = "daily-data-logger.records.v1";

class LoggerDatabase extends Dexie {
  entries!: Table<LogRecord, string>;
  outbox!: Table<OutboxOperation, string>;
  metadata!: Table<{ key: string; value: string }, string>;

  constructor() {
    super("daily-data-logger");
    this.version(1).stores({
      entries: "id, workspaceId, date, updatedAt, syncState, deletedAt",
      outbox: "operationId, entryId, workspaceId, createdAt",
      metadata: "key",
    });
  }
}

export const database = new LoggerDatabase();

export async function initializeDatabase(legacyRecords: LogRecord[], clearLegacyStorage = true): Promise<void> {
  await database.transaction("rw", database.entries, database.metadata, async () => {
    const migrated = await database.metadata.get(MIGRATION_KEY);
    if (migrated) return;

    if (legacyRecords.length && await database.entries.count() === 0) {
      await database.entries.bulkAdd(legacyRecords.map((record) => ({
        ...record,
        updatedAt: record.updatedAt || record.createdAt,
        workspaceId: null,
        serverVersion: null,
        syncState: "local",
        deletedAt: null,
      })));
    }

    await database.metadata.put({ key: MIGRATION_KEY, value: new Date().toISOString() });
  });
  if (clearLegacyStorage) localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export async function listRecords(workspaceId: string | null): Promise<LogRecord[]> {
  return (await database.entries.toArray())
    .filter((record) => record.workspaceId === workspaceId && (!record.deletedAt || record.syncState === "conflict"))
    .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt));
}

export async function getRecord(recordId: string): Promise<LogRecord | undefined> {
  return database.entries.get(recordId);
}

export async function saveRecord(record: LogRecord, action: "upsert" | "delete" = "upsert"): Promise<LogRecord> {
  const saved = { ...record, syncState: record.workspaceId ? "pending" as const : "local" as const };
  await database.transaction("rw", database.entries, database.outbox, async () => {
    await database.entries.put(saved);
    if (!saved.workspaceId) return;

    const existing = await database.outbox.where("entryId").equals(saved.id).first();
    await database.outbox.put({
      operationId: existing?.operationId ?? crypto.randomUUID(),
      entryId: saved.id,
      workspaceId: saved.workspaceId,
      action,
      expectedVersion: existing?.expectedVersion ?? saved.serverVersion,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  });
  return saved;
}

export async function removeLocalRecord(recordId: string): Promise<void> {
  await database.transaction("rw", database.entries, database.outbox, async () => {
    await database.entries.delete(recordId);
    const operation = await database.outbox.where("entryId").equals(recordId).first();
    if (operation) await database.outbox.delete(operation.operationId);
  });
}

export async function replaceLocalRecords(records: LogRecord[]): Promise<void> {
  await database.transaction("rw", database.entries, database.outbox, async () => {
    const allRecords = await database.entries.toArray();
    const localIds = new Set(allRecords.filter((record) => record.workspaceId === null).map((record) => record.id));
    const ids = [...localIds];
    if (ids.length) await database.entries.bulkDelete(ids);
    if (records.length) {
      await database.entries.bulkPut(records.map((record) => ({
        ...record,
        workspaceId: null,
        serverVersion: null,
        syncState: "local",
        deletedAt: null,
        conflictSnapshot: null,
      })));
    }
    const localOperations = await database.outbox.toArray();
    const obsolete = localOperations.filter((operation) => localIds.has(operation.entryId));
    if (obsolete.length) await database.outbox.bulkDelete(obsolete.map((operation) => operation.operationId));
  });
}

export async function localRecordCount(): Promise<number> {
  return (await database.entries.toArray()).filter((record) => record.workspaceId === null && !record.deletedAt).length;
}

export async function copyLocalRecordsToWorkspace(workspaceId: string): Promise<number> {
  const localRecords = await listRecords(null);
  let copied = 0;
  for (const record of localRecords) {
    const newId = crypto.randomUUID();
    const copy: LogRecord = {
      ...record,
      id: newId,
      updatedAt: new Date().toISOString(),
      items: record.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
      workspaceId,
      serverVersion: null,
      syncState: "pending",
      deletedAt: null,
      conflictSnapshot: null,
    };
    const marker = `workspaceCopy:${workspaceId}:${record.id}`;
    await database.transaction("rw", database.entries, database.outbox, database.metadata, async () => {
      if (await database.metadata.get(marker)) return;
      await database.entries.put(copy);
      await database.outbox.put({
        operationId: crypto.randomUUID(),
        entryId: copy.id,
        workspaceId,
        action: "upsert",
        expectedVersion: null,
        createdAt: new Date().toISOString(),
      });
      await database.metadata.put({ key: marker, value: copy.id });
      copied += 1;
    });
  }
  return copied;
}

export async function pendingCount(workspaceId: string): Promise<number> {
  return database.outbox.where("workspaceId").equals(workspaceId).count();
}

export async function conflictedCount(workspaceId: string): Promise<number> {
  return (await database.entries.toArray()).filter((record) =>
    record.workspaceId === workspaceId && record.syncState === "conflict").length;
}

export async function getMetadata(key: string): Promise<string | undefined> {
  return (await database.metadata.get(key))?.value;
}

export async function setMetadata(key: string, value: string): Promise<void> {
  await database.metadata.put({ key, value });
}
