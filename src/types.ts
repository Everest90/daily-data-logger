export type Payment = "Transfer" | "Cash" | "Credit" | "None" | "Not Yet";
export type SyncState = "local" | "pending" | "synced" | "conflict" | "failed";

export type RecordItem = {
  id: string;
  type: string;
  statement: string;
  detail: string;
  payment: Payment;
  collector: string;
  checkedIn: boolean;
  completed: boolean;
  completedAt: string;
};

export type LogRecord = {
  id: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  depositor: string;
  label: string;
  items: RecordItem[];
  workspaceId: string | null;
  serverVersion: number | null;
  syncState: SyncState;
  deletedAt: string | null;
  conflictSnapshot?: LogRecord | null;
};

export type Workspace = {
  id: string;
  name: string;
  timezone: string;
};

export type OutboxOperation = {
  operationId: string;
  entryId: string;
  workspaceId: string;
  action: "upsert" | "delete";
  expectedVersion: number | null;
  createdAt: string;
  error?: string;
};
