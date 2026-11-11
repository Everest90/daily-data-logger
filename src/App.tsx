import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  conflictedCount,
  copyLocalRecordsToWorkspace,
  getRecord,
  initializeDatabase,
  listRecords,
  localRecordCount,
  pendingCount as getPendingCount,
  removeLocalRecord,
  replaceLocalRecords,
  saveRecord,
  setMetadata,
  getMetadata,
} from "./database";
import { downloadPdfReport } from "./reports";
import { formatDate, formatTime } from "./reportFormatting";
import { supabaseConfigured } from "./supabase";
import { accessWorkspace, resolveConflict, syncWorkspace } from "./sync";
import type { LogRecord, Payment, RecordItem, Workspace } from "./types";

type DraftItem = Omit<RecordItem, "id"> & { id?: string; collectorName?: string };
type QuickDraftItem = { id: string; type: string; statement: string; detail: string };
type Toast = { message: string; kind: "success" | "error"; undo?: boolean };
type Filters = { item: string; payment: string; status: string };
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const STORAGE_KEY = "daily-data-logger.records.v1";
const THEME_KEY = "daily-data-logger.theme";
const WORKSPACE_KEY = "workspace";
const SCOPE_KEY = "activeScope";
const ITEM_TYPES = ["Phone", "Powerbank", "Laptop", "Others"];
const STATEMENTS = ["Charger", "Cord", "Adaptor", "None"];
const PAYMENTS: Payment[] = ["Transfer", "Cash", "Credit", "None", "Not Yet"];
const QUOTES = [
  ["Data is the new oil. It's valuable, but if unrefined it cannot really be used.", "Clive Humby"],
  ["Without data, you're just another person with an opinion.", "W. Edwards Deming"],
  ["Data beats emotions.", "Sean Rad"],
  ["The world is one big data problem.", "Andrew McAfee"],
  ["Data is a precious thing and will last longer than the systems themselves.", "Tim Berners-Lee"],
];

const emptyItem = (): DraftItem => ({
  type: "",
  statement: "",
  detail: "",
  payment: "" as Payment,
  collector: "",
  checkedIn: false,
  completed: false,
  completedAt: "",
});

const emptyQuickItem = (): QuickDraftItem => ({ id: crypto.randomUUID(), type: "Powerbank", statement: "None", detail: "" });

function localDateKey(date = new Date(), timezone?: string): string {
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function displayType(item: RecordItem | DraftItem): string {
  return item.type === "Others" && item.detail.startsWith("Other item: ")
    ? item.detail.slice(12)
    : item.type === "Others" ? "Other" : item.type;
}

function countItemTypes(records: LogRecord[], itemsForRecord: (record: LogRecord) => RecordItem[] = (record) => record.items) {
  const counts = new Map(ITEM_TYPES.map((type) => [type, 0]));
  for (const record of records) {
    for (const item of itemsForRecord(record)) {
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    }
  }
  return ITEM_TYPES.map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

function isPayment(value: unknown): value is Payment {
  return typeof value === "string" && PAYMENTS.some((payment) => payment === value);
}

function isValidItem(value: unknown): value is RecordItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RecordItem>;
  return typeof row.id === "string" && !!row.id &&
    typeof row.type === "string" && ITEM_TYPES.some((type) => type === row.type) &&
    typeof row.statement === "string" && STATEMENTS.some((statement) => statement === row.statement) &&
    typeof row.detail === "string" &&
    isPayment(row.payment) &&
    typeof row.collector === "string" &&
    typeof row.checkedIn === "boolean" &&
    typeof row.completed === "boolean" &&
    typeof row.completedAt === "string" &&
    (!row.completedAt || !Number.isNaN(Date.parse(row.completedAt))) &&
    (!row.completed || !!row.completedAt);
}

function isValidRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LogRecord>;
  if (
    typeof candidate.id !== "string" || !candidate.id ||
    typeof candidate.date !== "string" || !isDateKey(candidate.date) ||
    typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt)) ||
    typeof candidate.depositor !== "string" || !candidate.depositor.trim() ||
    typeof candidate.label !== "string" ||
    !Array.isArray(candidate.items) || candidate.items.length === 0
  ) return false;
  if (!candidate.items.every(isValidItem)) return false;
  return new Set(candidate.items.map((item) => item.id)).size === candidate.items.length;
}

function parseBackup(value: unknown): LogRecord[] {
  if (!value || typeof value !== "object") throw new Error("The selected file is not a Daily Data Logger backup.");
  const backup = value as { format?: unknown; version?: unknown; records?: unknown };
  if (backup.format !== "daily-data-logger-backup" || backup.version !== 1 || !Array.isArray(backup.records)) {
    throw new Error("Unsupported backup format. Choose a Daily Data Logger JSON backup.");
  }
  if (!backup.records.every(isValidRecord)) throw new Error("Backup validation failed. No data was imported.");
  const ids = backup.records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error("The backup contains duplicate record IDs.");
  return backup.records;
}

function matchingItems(record: LogRecord, query: string, filters: Filters): RecordItem[] {
  const search = query.trim().toLowerCase();
  const recordMatches = [record.depositor, record.label].some((value) => value.toLowerCase().includes(search));
  return record.items.filter((item) => {
    const matchesSearch = !search || recordMatches ||
      [displayType(item), item.statement, item.detail, item.payment, item.collector]
        .some((value) => value.toLowerCase().includes(search));
    return matchesSearch &&
      (!filters.item || (item.type === "Others" ? filters.item === "Other" : item.type === filters.item)) &&
      (!filters.payment || item.payment === filters.payment) &&
      (!filters.status || (item.completed ? "Completed" : "Pending") === filters.status);
  });
}

function normalizeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) ? String(numeric) : trimmed.toLocaleLowerCase();
}

function isValidLabel(value: string): boolean {
  if (!value.trim()) return true;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 10000;
}

function similarDepositors(records: LogRecord[], value: string): LogRecord[] {
  const query = value.trim().toLocaleLowerCase();
  if (!query) return [];
  const newestFirst = [...records].sort((a, b) =>
    b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const seen = new Set<string>();
  return newestFirst.filter((record) => {
    const name = record.depositor.trim();
    const normalized = name.toLocaleLowerCase();
    if (!name || !normalized.includes(query) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, 6);
}

function isLabelReusable(records: LogRecord[], label: string, exceptRecordId?: string): boolean {
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  return !records.some((record) =>
    record.id !== exceptRecordId &&
    !record.deletedAt &&
    normalizeLabel(record.label) === normalized &&
    record.items.some((item) => !item.completed));
}

function normalizeRecord(record: LogRecord): LogRecord {
  return {
    ...record,
    updatedAt: record.updatedAt || record.createdAt,
    workspaceId: null,
    serverVersion: null,
    syncState: "local",
    deletedAt: null,
    conflictSnapshot: null,
  };
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Partial<Workspace>;
  return typeof workspace.id === "string" && !!workspace.id &&
    typeof workspace.name === "string" && typeof workspace.timezone === "string";
}

function App() {
  const reduceMotion = useReducedMotion();
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [dataScope, setDataScope] = useState<"local" | "workspace">("local");
  const [syncLabel, setSyncLabel] = useState("Local device");
  const [pendingChanges, setPendingChanges] = useState(0);
  const [localCount, setLocalCount] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"create" | "join">("join");
  const [busy, setBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  const [page, setPage] = useState<"today" | "history">("today");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>({ item: "", payment: "", status: "" });
  const [historySearch, setHistorySearch] = useState("");
  const [historyFilters, setHistoryFilters] = useState<Filters>({ item: "", payment: "", status: "" });
  const [depositor, setDepositor] = useState("");
  const [label, setLabel] = useState("");
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [entryMode, setEntryMode] = useState<"full" | "quick">("full");
  const [quickDepositor, setQuickDepositor] = useState("");
  const [quickLabel, setQuickLabel] = useState("");
  const [quickItems, setQuickItems] = useState<QuickDraftItem[]>([emptyQuickItem()]);
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [now, setNow] = useState(new Date());
  const [deleted, setDeleted] = useState<LogRecord | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const syncInProgress = useRef(false);
  const pinStorageKey = `pinnedRecords:${dataScope === "workspace" ? workspace?.id ?? "unavailable" : "local"}`;
  const today = localDateKey(now, dataScope === "workspace" ? workspace?.timezone : undefined);
  const blockedLabels = useMemo(() => new Set(records
    .filter((record) => !record.deletedAt && record.items.some((item) => !item.completed))
    .map((record) => normalizeLabel(record.label))), [records]);
  const activePinnedIds = useMemo(() => pinnedIds.filter((id) => records.some((record) => record.id === id)), [pinnedIds, records]);
  const completeAll = items.length > 0 && items.every((item) => item.completed);
  const quote = QUOTES[Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000) % QUOTES.length];
  const todayRecords = useMemo(() => records.filter((record) => record.date === today && !record.deletedAt), [records, today]);
  const sortedTodayRecords = useMemo(() => [...todayRecords].sort((a, b) =>
    Number(activePinnedIds.includes(b.id)) - Number(activePinnedIds.includes(a.id)) ||
    b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [todayRecords, activePinnedIds]);

  useEffect(() => {
    let active = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      let legacyRecords: LogRecord[] = [];
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (!Array.isArray(parsed) || !parsed.every(isValidRecord)) {
          throw new Error("Saved data is invalid. Export or restore a valid backup to continue.");
        }
        if (new Set(parsed.map((record) => record.id)).size !== parsed.length) {
          throw new Error("Saved data contains duplicate record IDs. Restore a valid backup to continue.");
        }
        legacyRecords = parsed.map(normalizeRecord);
      }
      void (async () => {
        try {
          await initializeDatabase(legacyRecords);
          const savedWorkspace = await getMetadata(WORKSPACE_KEY);
          let restoredWorkspace: Workspace | null = null;
          if (savedWorkspace) {
            const parsedWorkspace: unknown = JSON.parse(savedWorkspace);
            if (!isWorkspace(parsedWorkspace)) throw new Error("Saved workspace information is invalid. Reconnect this device.");
            restoredWorkspace = parsedWorkspace;
          }
          const savedScope = await getMetadata(SCOPE_KEY);
          const restoredScope = savedScope === "workspace" && restoredWorkspace ? "workspace" : "local";
          const savedRecords = await listRecords(restoredScope === "workspace" ? restoredWorkspace?.id ?? null : null);
          if (active) {
            setWorkspace(restoredWorkspace);
            setDataScope(restoredScope);
            setRecords(savedRecords);
            setLocalCount(await localRecordCount());
            setStorageReady(true);
          }
          if (active && restoredScope === "workspace" && restoredWorkspace && navigator.onLine) {
            await runSync(restoredWorkspace);
          }
        } catch (error) {
          if (active) {
            setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not initialize local storage." });
            setRecords(await listRecords(null));
            setStorageReady(true);
          }
        }
      })();
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not read saved data." });
      void initializeDatabase([], false).then(async () => {
        if (active) {
          setRecords(await listRecords(null));
          setStorageReady(true);
        }
      }).catch((databaseError: unknown) => {
        if (active) setToast({ kind: "error", message: databaseError instanceof Error ? databaseError.message : "Could not initialize local storage." });
      });
    }
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    void getMetadata(pinStorageKey).then((value) => {
      if (!active) return;
      if (!value) {
        setPinnedIds([]);
        return;
      }
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
        throw new Error("Saved pinned-entry preferences are invalid.");
      }
      setPinnedIds(parsed.slice(0, 5));
    }).catch((error: unknown) => {
      if (active) setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not load pinned entries." });
    });
    return () => { active = false; };
  }, [pinStorageKey]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not save theme preference: ${error.message}` : "Could not save theme preference." });
    }
  }, [theme]);

  const refreshRecords = async (scope: "local" | "workspace" = dataScope, target = workspace) => {
    try {
      const workspaceId = scope === "workspace" ? target?.id : null;
      setRecords(await listRecords(workspaceId ?? null));
      setLocalCount(await localRecordCount());
      if (target) {
        setPendingChanges(await getPendingCount(target.id));
        setConflicts(await conflictedCount(target.id));
      }
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not load records: ${error.message}` : "Could not load records." });
    }
  };

  const runSync = async (target = workspace) => {
    if (!target) {
      setSyncLabel("Local device");
      return;
    }
    if (!navigator.onLine) {
      setSyncLabel("Offline · saved on device");
      return;
    }
    if (syncInProgress.current) return;
    syncInProgress.current = true;
    setSyncLabel("Syncing…");
    try {
      await syncWorkspace(target);
      const [remaining, unresolved] = await Promise.all([
        getPendingCount(target.id),
        conflictedCount(target.id),
      ]);
      setPendingChanges(remaining);
      setConflicts(unresolved);
      setSyncLabel(unresolved ? "Resolve sync conflicts" : remaining ? `${remaining} changes waiting to sync` : "All changes synced");
      if (dataScope === "workspace" && workspace?.id === target.id) await refreshRecords("workspace", target);
    } catch (error) {
      const [remaining, unresolved] = await Promise.all([
        getPendingCount(target.id),
        conflictedCount(target.id),
      ]);
      setPendingChanges(remaining);
      setConflicts(unresolved);
      setSyncLabel(unresolved ? "Resolve sync conflicts" : "Sync needs attention");
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not sync changes." });
    } finally {
      syncInProgress.current = false;
    }
  };

  useEffect(() => {
    const handleOnline = () => { void runSync(); };
    const handleOffline = () => { if (workspace) setSyncLabel("Offline · saved on device"); };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    const interval = workspace ? window.setInterval(() => { void runSync(); }, 60_000) : undefined;
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [workspace, dataScope]);

  useEffect(() => {
    if (storageReady) void refreshRecords(dataScope, workspace);
  }, [dataScope, workspace, storageReady]);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
  }, []);

  const updateItem = (index: number, patch: Partial<DraftItem>) => {
    setItems((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  };

  const loadQuickEntryFromRecord = (record: LogRecord) => {
    setQuickDepositor(record.depositor);
    setQuickLabel(record.label);
    setQuickItems(record.items.map((item) => ({
      id: crypto.randomUUID(),
      type: item.type,
      statement: item.statement,
      detail: item.type === "Others" ? item.detail.replace(/^Other item: /, "") : "",
    })));
  };

  const loadFullEntryFromRecord = (record: LogRecord) => {
    setDepositor(record.depositor);
    setLabel(record.label);
    setItems(record.items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      detail: item.type === "Others" ? item.detail.replace(/^Other item: /, "") : item.detail,
    })));
  };

  const resetForm = () => {
    setDepositor("");
    setLabel("");
    setItems([emptyItem()]);
    setInlineEditingId(null);
    setEntryMode("full");
  };

  const saveEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDepositor = depositor.trim();
    const cleanLabel = label.trim();
    if (!cleanDepositor) {
      setToast({ kind: "error", message: "Add a depositor name before saving." });
      return;
    }
    if (!isValidLabel(cleanLabel)) {
      setToast({ kind: "error", message: "Label must be a whole number from 1 to 10000." });
      return;
    }
    if (cleanLabel && blockedLabels.has(normalizeLabel(cleanLabel))) {
      setToast({ kind: "error", message: "This label is still in use by an entry with pending items." });
      return;
    }
    if (!items.length || items.some((item) => !item.type || !item.statement || !item.payment || (item.type === "Others" && !item.detail.trim()))) {
      setToast({ kind: "error", message: "Complete the required item, statement, payment, and custom item fields." });
      return;
    }
    const timestamp = new Date().toISOString();
    const savedItems: RecordItem[] = items.map((item) => ({
      id: item.id ?? crypto.randomUUID(),
      type: item.type,
      statement: item.statement,
      detail: item.type === "Others" ? `Other item: ${item.detail.trim()}` : item.detail.trim(),
      payment: item.payment,
      collector: item.collector === "__depositor"
        ? cleanDepositor
        : item.collector === "__custom" ? item.collectorName?.trim() ?? "" : item.collector.trim(),
      checkedIn: false,
      completed: item.completed,
      completedAt: item.completed ? item.completedAt || timestamp : "",
    }));
    const nextRecord: LogRecord = {
      id: crypto.randomUUID(),
      date: today,
      createdAt: timestamp,
      updatedAt: timestamp,
      depositor: cleanDepositor,
      label: cleanLabel,
      items: savedItems,
      workspaceId: dataScope === "workspace" ? workspace?.id ?? null : null,
      serverVersion: null,
      syncState: dataScope === "workspace" ? "pending" : "local",
      deletedAt: null,
    };
    try {
      await saveRecord(nextRecord);
      await refreshRecords();
      resetForm();
      setToast({ kind: "success", message: "Entry saved." });
      if (nextRecord.workspaceId && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not save locally: ${error.message}` : "Could not save data on this device." });
    }
  };

  const saveQuickEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDepositor = quickDepositor.trim();
    const cleanLabel = quickLabel.trim();
    if (!cleanDepositor ||
      !quickItems.length ||
      quickItems.some((item) => !item.type || !STATEMENTS.includes(item.statement) || (item.type === "Others" && !item.detail.trim()))) {
      setToast({ kind: "error", message: "Add a depositor and valid item details before saving." });
      return;
    }
    if (!isValidLabel(cleanLabel)) {
      setToast({ kind: "error", message: "Label must be a whole number from 1 to 10000." });
      return;
    }
    if (cleanLabel && blockedLabels.has(normalizeLabel(cleanLabel))) {
      setToast({ kind: "error", message: "This label is still in use by an entry with pending items." });
      return;
    }

    const timestamp = new Date().toISOString();
    const record: LogRecord = {
      id: crypto.randomUUID(),
      date: today,
      createdAt: timestamp,
      updatedAt: timestamp,
      depositor: cleanDepositor,
      label: cleanLabel,
      items: quickItems.map((item) => ({
        id: crypto.randomUUID(),
        type: item.type,
        statement: item.statement,
        detail: item.type === "Others" ? `Other item: ${item.detail.trim()}` : "",
        payment: "Not Yet",
        collector: "",
        checkedIn: false,
        completed: false,
        completedAt: "",
      })),
      workspaceId: dataScope === "workspace" ? workspace?.id ?? null : null,
      serverVersion: null,
      syncState: dataScope === "workspace" ? "pending" : "local",
      deletedAt: null,
    };

    try {
      await saveRecord(record);
      await refreshRecords();
      setQuickDepositor("");
      setQuickLabel("");
      setQuickItems([emptyQuickItem()]);
      setToast({ kind: "success", message: "Quick entry saved. Payment is set to Not Yet." });
      if (record.workspaceId && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not save quick entry: ${error.message}` : "Could not save quick entry." });
    }
  };

  const startInlineEdit = (record: LogRecord) => {
    if (record.syncState === "conflict") return;
    setInlineEditingId(record.id);
  };

  const saveInlineEdit = async (record: LogRecord, changes: Pick<LogRecord, "depositor" | "label" | "items">) => {
    const depositorName = changes.depositor.trim();
    const nextLabel = changes.label.trim();
    if (!depositorName || !changes.items.length) {
      setToast({ kind: "error", message: "Depositor and at least one item are required." });
      return false;
    }
    if (!isValidLabel(nextLabel)) {
      setToast({ kind: "error", message: "Label must be a whole number from 1 to 10000." });
      return false;
    }
    if (nextLabel && normalizeLabel(nextLabel) !== normalizeLabel(record.label) &&
      !isLabelReusable(records, nextLabel, record.id)) {
      setToast({ kind: "error", message: "This label is still in use by another entry with pending items." });
      return false;
    }
    if (changes.items.some((item) =>
      !ITEM_TYPES.includes(item.type) ||
      !STATEMENTS.includes(item.statement) ||
      !isPayment(item.payment) ||
      (item.completed && !item.completedAt))) {
      setToast({ kind: "error", message: "Check each item’s type, statement, payment, and completion details." });
      return false;
    }

    const updated: LogRecord = {
      ...record,
      depositor: depositorName,
      label: nextLabel,
      items: changes.items,
      updatedAt: new Date().toISOString(),
      syncState: record.workspaceId ? "pending" : "local",
      conflictSnapshot: null,
    };
    try {
      await saveRecord(updated);
      setInlineEditingId(null);
      await refreshRecords();
      setToast({ kind: "success", message: "Entry updated." });
      if (updated.workspaceId && navigator.onLine) await runSync(workspace);
      return true;
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not update entry: ${error.message}` : "Could not update entry." });
      return false;
    }
  };

  const toggleCompleted = async (record: LogRecord, itemId: string) => {
    const timestamp = new Date().toISOString();
    const updated: LogRecord = {
      ...record,
      updatedAt: timestamp,
      items: record.items.map((item) => item.id === itemId
        ? { ...item, completed: !item.completed, completedAt: item.completed ? "" : timestamp }
        : item),
    };
    try {
      await saveRecord(updated);
      await refreshRecords();
      if (updated.workspaceId && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not update completion: ${error.message}` : "Could not update completion." });
    }
  };

  const changePayment = async (record: LogRecord, itemId: string, payment: Payment) => {
    const updated: LogRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      items: record.items.map((item) => item.id === itemId ? { ...item, payment } : item),
    };
    try {
      await saveRecord(updated);
      await refreshRecords();
      if (updated.workspaceId && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not update payment: ${error.message}` : "Could not update payment." });
    }
  };

  const togglePinned = async (record: LogRecord) => {
    const isPinned = activePinnedIds.includes(record.id);
    if (!isPinned && activePinnedIds.length >= 5) {
      setToast({ kind: "error", message: "You can pin up to five entries. Unpin one before adding another." });
      return;
    }
    const next = isPinned ? activePinnedIds.filter((id) => id !== record.id) : [record.id, ...activePinnedIds];
    try {
      await setMetadata(pinStorageKey, JSON.stringify(next));
      setPinnedIds(next);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not update pinned entries: ${error.message}` : "Could not update pinned entries." });
    }
  };

  const deleteRecord = async (record: LogRecord) => {
    if (!records.some((entry) => entry.id === record.id)) return;
    try {
      if (record.workspaceId) {
        if (record.serverVersion === null) {
          await removeLocalRecord(record.id);
        } else {
          await saveRecord({ ...record, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "delete");
        }
      } else {
        await removeLocalRecord(record.id);
      }
      await refreshRecords();
      setDeleted(record);
      setToast({ kind: "success", message: "Entry deleted.", undo: true });
      if (record.workspaceId && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not delete entry: ${error.message}` : "Could not delete entry." });
    }
  };

  const undoDelete = async () => {
    if (!deleted) return;
    try {
      const current = await getRecord(deleted.id);
      await saveRecord({
        ...(current ?? deleted),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });
      await refreshRecords();
      setDeleted(null);
      setToast({ kind: "success", message: "Deletion undone." });
      if (deleted.workspaceId && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not undo deletion: ${error.message}` : "Could not undo deletion." });
    }
  };

  const displayedToday = todayRecords.filter((record) => matchingItems(record, search, filters).length > 0);

  const historyRecords = useMemo(() => records.filter((record) => {
    return matchingItems(record, historySearch, historyFilters).length > 0;
  }).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [records, historySearch, historyFilters]);

  const sortedHistoryRecords = useMemo(() => [...historyRecords].sort((a, b) =>
    Number(activePinnedIds.includes(b.id)) - Number(activePinnedIds.includes(a.id)) ||
    b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [historyRecords, activePinnedIds]);
  const pinnedHistoryRecords = useMemo(() => sortedHistoryRecords.filter((record) => activePinnedIds.includes(record.id)), [sortedHistoryRecords, activePinnedIds]);

  const historyGroups = useMemo(() => sortedHistoryRecords.filter((record) => !activePinnedIds.includes(record.id)).reduce<Record<string, LogRecord[]>>((groups, record) => {
    (groups[record.date] ??= []).push(record);
    return groups;
  }, {}), [sortedHistoryRecords, activePinnedIds]);

  const stats = useMemo(() => {
    const dayItems = todayRecords.flatMap((record) => record.items);
    return {
      entries: todayRecords.length,
      items: dayItems.length,
      completed: dayItems.filter((item) => item.completed).length,
      pending: dayItems.filter((item) => !item.completed).length,
      followups: dayItems.filter((item) => !item.completed && ["Credit", "None", "Not Yet"].includes(item.payment)).length,
      itemTypes: countItemTypes(todayRecords),
    };
  }, [todayRecords]);

  const reminders = useMemo(() => records.filter((record) => !record.deletedAt).flatMap((record) => record.items
    .filter((item) => !item.completed && ["Credit", "None", "Not Yet"].includes(item.payment))
    .map((item) => ({ record, item }))), [records]);

  const exportBackup = () => {
    const backupRecords = records.filter((record) => !record.deletedAt).map(normalizeRecord);
    const blob = new Blob([JSON.stringify({ format: "daily-data-logger-backup", version: 1, exportedAt: new Date().toISOString(), records: backupRecords }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `daily-data-logger-backup-${today}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast({ kind: "success", message: "JSON backup downloaded." });
  };

  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = parseBackup(JSON.parse(await file.text()));
      if (dataScope !== "local") throw new Error("Switch to Local device before restoring a backup. This keeps shared workspace data safe.");
      if (!window.confirm(`Restore ${parsed.length} records from this backup? This replaces the records currently saved in this browser.`)) return;
      const localRecords = parsed.map(normalizeRecord);
      await replaceLocalRecords(localRecords);
      await refreshRecords("local");
      resetForm();
      setToast({ kind: "success", message: `${parsed.length} records restored.` });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not read this backup file." });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const printReport = async (scope: "today" | "all") => {
    const source = scope === "today"
      ? todayRecords
      : records.filter((record) => !record.deletedAt).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    try {
      await downloadPdfReport(
        source,
        scope,
        today,
        dataScope === "workspace" ? workspace?.name : undefined,
        dataScope === "workspace" && (!navigator.onLine || pendingChanges > 0 || syncLabel !== "All changes synced"),
      );
      setToast({ kind: "success", message: "PDF report downloaded." });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not generate the PDF report." });
    }
  };

  const changeScope = async (scope: "local" | "workspace") => {
    if (scope === "workspace" && !workspace) {
      setToast({ kind: "error", message: "Connect this device to a workspace first." });
      return;
    }
    setDataScope(scope);
    await setMetadata(SCOPE_KEY, scope);
    await refreshRecords(scope, workspace);
    if (scope === "workspace" && workspace && navigator.onLine) await runSync(workspace);
  };

  const connectWorkspace = async (values: { action: "create" | "join"; name: string; code: string }) => {
    setBusy(true);
    setErrorMessage("");
    try {
      const connected = await accessWorkspace(values.action, {
        code: values.code,
        ...(values.action === "create" ? { workspaceName: values.name } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      await setMetadata(WORKSPACE_KEY, JSON.stringify(connected));
      await setMetadata(SCOPE_KEY, "workspace");
      setWorkspace(connected);
      setDataScope("workspace");
      setWorkspaceDialog(false);
      setToast({ kind: "success", message: `Connected to ${connected.name}. Local records were not shared.` });
      await refreshRecords("workspace", connected);
      await runSync(connected);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not connect to the workspace.");
    } finally {
      setBusy(false);
    }
  };

  const uploadLocalRecords = async () => {
    if (!workspace || !localCount) return;
    if (!window.confirm(`Copy ${localCount} local records to ${workspace.name}? The original local records will be kept. Workspace members can view and edit the copies.`)) return;
    setBusy(true);
    try {
      const copied = await copyLocalRecordsToWorkspace(workspace.id);
      await refreshRecords("workspace", workspace);
      setToast({ kind: "success", message: copied ? `${copied} local records copied to the workspace.` : "These local records were already copied to the workspace." });
      if (navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not upload local records: ${error.message}` : "Could not upload local records." });
    } finally {
      setBusy(false);
    }
  };

  const resolveEntryConflict = async (record: LogRecord, choice: "local" | "server") => {
    try {
      await resolveConflict(record, choice);
      await refreshRecords("workspace", workspace);
      if (workspace && navigator.onLine) await runSync(workspace);
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? `Could not resolve conflict: ${error.message}` : "Could not resolve conflict." });
    }
  };

  const installApp = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (outcome === "accepted") setToast({ kind: "success", message: "Daily Data Logger was installed." });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Could not start app installation." });
    }
  };

  const motionDuration = reduceMotion ? 0 : 0.18;

  return (
    <main className="min-h-screen px-4 pb-14 pt-5 sm:px-7 lg:px-10" aria-busy={!storageReady}>
      <div className="app-shell mx-auto max-w-[1440px]">
        <header className="topbar">
          <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage("today"); }} aria-label="Daily Data Logger home">
            <span className="brand-mark" aria-hidden="true">D</span>
            <span><strong>Daily Data Logger</strong><small>Offline-ready · saved on this device</small></span>
          </a>
          <div className="topbar-actions">
            <time className="today-chip" dateTime={today}>{formatDate(today, { weekday: "short", month: "short", day: "numeric" })}</time>
            {installPrompt && <button type="button" className="button button-quiet compact install-button" onClick={() => void installApp()}>Install app</button>}
            {workspace && <button type="button" className="button button-quiet compact scope-button" onClick={() => void changeScope(dataScope === "local" ? "workspace" : "local")}>
              {dataScope === "local" ? `Use ${workspace.name}` : "Local device"}
            </button>}
            {dataScope === "workspace" && workspace && <button type="button" className="button button-quiet compact sync-button" onClick={() => void runSync()} disabled={busy || syncLabel === "Syncing…"}>
              {syncLabel === "Syncing…" ? "Syncing…" : pendingChanges > 0 ? `Sync · ${pendingChanges}` : "Sync now"}
            </button>}
            <button type="button" className="button button-quiet compact connect-button" onClick={() => { setErrorMessage(""); setWorkspaceDialog(true); }}>
              {workspace ? "Workspace settings" : "Connect workspace"}
            </button>
            <button type="button" className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? "☼" : "☾"}
            </button>
          </div>
        </header>

        <section className="quote-banner" aria-label="Daily quote">
          <span className="quote-mark" aria-hidden="true">“</span>
          <div><p>{quote[0]}</p><span>— {quote[1]}</span></div>
          <time className="live-time">{now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
        </section>

        {dataScope === "workspace" && workspace && <div className={`sync-banner ${conflicts ? "has-conflicts" : ""}`} role="status">
          <span className="privacy-dot" />
          <span><strong>{workspace.name}</strong> · {syncLabel}{pendingChanges > 0 && ` · ${pendingChanges} pending`}</span>
          {localCount > 0 && <button type="button" className="text-button" onClick={() => void uploadLocalRecords()} disabled={busy}>Copy {localCount} local {localCount === 1 ? "record" : "records"} to workspace</button>}
        </div>}
        {!supabaseConfigured && <div className="sync-banner setup-hint">
          Team sync is optional. Configure a Supabase project to connect devices; local logging and offline storage work without it.
        </div>}

        <nav className="page-tabs" aria-label="Main views">
          <button type="button" className={page === "today" ? "tab active" : "tab"} onClick={() => setPage("today")}>Today <span>{todayRecords.length}</span></button>
          <button type="button" className={page === "history" ? "tab active" : "tab"} onClick={() => setPage("history")}>All records <span>{records.length}</span></button>
          <div className="tab-tools">
            <button type="button" className="button button-quiet" onClick={exportBackup}>Download backup</button>
            <button type="button" className="button button-quiet" onClick={() => fileInput.current?.click()} disabled={dataScope === "workspace"} title={dataScope === "workspace" ? "Switch to Local device before restoring a backup." : undefined}>Restore JSON</button>
            <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json" aria-label="Choose a JSON backup" onChange={(event) => void importBackup(event.target.files?.[0])} />
          </div>
        </nav>

        <AnimatePresence mode="wait">
          {page === "today" ? (
            <motion.div key="today" initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: motionDuration }}>
              <section className="section-heading">
                <div><p className="eyebrow">Daily overview</p><h1>Today’s activity</h1><p className="muted">{formatDate(today)} <span className="dot">·</span> Keep every handoff in one place.</p></div>
                <button type="button" className="button button-outline" onClick={() => void printReport("today")}>Download today’s PDF</button>
              </section>

              <section className="stats-grid" aria-label="Today's statistics">
                <StatCard label="Entries today" value={stats.entries} foot="Depositor records" tone="blue" />
                <StatCard label="Items logged" value={stats.items} foot="Across all entries" tone="violet" />
                <StatCard label="Completed" value={stats.completed} foot={stats.items ? `${Math.round(stats.completed / stats.items * 100)}% of today’s items` : "Nothing completed yet"} tone="green" />
                <StatCard label="Needs follow-up" value={stats.followups} foot="Credit, none, or not yet paid" tone="amber" />
              </section>
              <ItemTypeCounts counts={stats.itemTypes} className="daily-type-counts" />

              {reminders.length > 0 && <details className="reminder-box">
                <summary><span className="reminder-icon">!</span><span><strong>{reminders.length} payment {reminders.length === 1 ? "reminder" : "reminders"}</strong><small>Pending items with Credit, None, or Not Yet payment</small></span><span className="summary-caret">⌄</span></summary>
                <div className="reminder-list">{reminders.map(({ record, item }) => <button key={`${record.id}-${item.id}`} type="button" className="reminder-row" onClick={() => { setPage(record.date === today ? "today" : "history"); setSearch(""); setFilters({ item: "", payment: "", status: "" }); setHistorySearch(""); setHistoryFilters({ item: "", payment: "", status: "" }); startInlineEdit(record); }}>
                  <span><strong>{record.depositor}</strong><small>{displayType(item)} · {record.label || "—"} · {formatDate(record.date, { month: "short", day: "numeric", year: "numeric" })}</small></span><span className="pill pill-amber">{item.payment}</span>
                </button>)}</div>
              </details>}

              <div className="dashboard-layout">
                <section className="panel form-panel" aria-labelledby="entry-form-heading">
                  <div className="panel-heading">
                    <div><p className="eyebrow">Capture a handoff</p><h2 id="entry-form-heading">{entryMode === "quick" ? "Quick entry" : "New entry"}</h2></div>
                    <div className="entry-mode-tools" role="group" aria-label="Entry form mode">
                        <button type="button" className={`button compact ${entryMode === "quick" ? "button-primary" : "button-quiet"}`} onClick={() => setEntryMode("quick")} aria-pressed={entryMode === "quick"}>Quick entry</button>
                        <button type="button" className={`button compact ${entryMode === "full" ? "button-primary" : "button-quiet"}`} onClick={() => setEntryMode("full")} aria-pressed={entryMode === "full"}>Full entry</button>
                    </div>
                  </div>
                  {entryMode === "quick" ? <form onSubmit={saveQuickEntry}>
                    <div className="form-grid two-col">
                      <div className="field-with-suggestions"><Field label="Depositor name" required><input value={quickDepositor} onChange={(event) => setQuickDepositor(event.target.value)} placeholder="e.g. Jamie Lee" required maxLength={100} autoComplete="off" /></Field><DepositorSuggestions records={records} value={quickDepositor} onChoose={loadQuickEntryFromRecord} /></div>
                      <Field label="Label (optional)"><input type="number" min={1} max={10000} step={1} value={quickLabel} onChange={(event) => setQuickLabel(event.target.value)} placeholder="1–10000" /></Field>
                    </div>
                    {quickLabel.trim() && blockedLabels.has(normalizeLabel(quickLabel)) && <p className="label-warning" role="status">This label has an entry with pending items and cannot be reused yet.</p>}
                    <div className="items-heading"><h3>Items <span className="count-badge">{quickItems.length}</span></h3><span className="muted">Item type and statement only</span></div>
                    <div className="item-stack">
                      {quickItems.map((item, index) => <fieldset className="item-card" key={item.id}>
                        <legend>Item {index + 1}</legend>
                        {quickItems.length > 1 && <button type="button" className="remove-item" onClick={() => setQuickItems((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`Remove item ${index + 1}`}>×</button>}
                        <div className="form-grid two-col">
                          <Field label="Item type" required><select value={item.type} onChange={(event) => setQuickItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, type: event.target.value, detail: event.target.value === "Others" ? entry.detail : "" } : entry))} required>{ITEM_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field>
                          <Field label="Statement" required><select value={item.statement} onChange={(event) => setQuickItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, statement: event.target.value } : entry))} required>{STATEMENTS.map((statement) => <option key={statement}>{statement}</option>)}</select></Field>
                        </div>
                        {item.type === "Others" && <div className="form-grid"><Field label="Custom item" required><input value={item.detail} onChange={(event) => setQuickItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, detail: event.target.value } : entry))} placeholder="Describe the item" required maxLength={100} /></Field></div>}
                      </fieldset>)}
                    </div>
                    <div className="form-end">
                      <button type="button" className="button button-outline" onClick={() => setQuickItems((current) => [...current, emptyQuickItem()])}>＋ Add another item</button>
                    </div>
                    <p className="muted quick-entry-note">Payment is automatically set to Not Yet.</p>
                    <div className="form-actions">
                      <button type="submit" className="button button-primary" disabled={!!quickLabel.trim() && blockedLabels.has(normalizeLabel(quickLabel))}>Save quick entry</button>
                      <button type="button" className="button button-quiet" onClick={() => { setQuickDepositor(""); setQuickLabel(""); setQuickItems([emptyQuickItem()]); }}>Clear form</button>
                    </div>
                  </form> : <form onSubmit={saveEntry}>
                    <div className="form-grid two-col">
                      <div className="field-with-suggestions"><Field label="Depositor name" required><input value={depositor} onChange={(event) => setDepositor(event.target.value)} placeholder="e.g. Jamie Lee" required maxLength={100} autoComplete="off" /></Field><DepositorSuggestions records={records} value={depositor} onChoose={loadFullEntryFromRecord} /></div>
                      <Field label="Label (optional)"><input type="number" min={1} max={10000} step={1} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="1–10000" /></Field>
                    </div>
                    {label.trim() && blockedLabels.has(normalizeLabel(label)) && <p className="label-warning" role="status">This label has an entry with pending items and cannot be reused yet.</p>}

                    <div className="items-heading"><h3>Items <span className="count-badge">{items.length}</span></h3><span className="muted">Add one or more items to this entry</span></div>
                    <div className="item-stack">
                      {items.map((item, index) => <fieldset className="item-card" key={item.id ?? `new-${index}`}>
                        <legend>Item {index + 1}</legend>
                        {items.length > 1 && <button type="button" className="remove-item" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove item ${index + 1}`}>×</button>}
                        <div className="form-grid two-col">
                          <Field label="Item type" required><select value={item.type === "Others" ? "Others" : item.type} onChange={(event) => updateItem(index, { type: event.target.value, detail: "" })} required><option value="">Select an item</option>{ITEM_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field>
                          {item.type === "Others" ? <Field label="Custom item" required><input value={item.detail} onChange={(event) => updateItem(index, { detail: event.target.value })} placeholder="Describe the item" required maxLength={100} /></Field> : <Field label="Statement" required><select value={item.statement} onChange={(event) => updateItem(index, { statement: event.target.value })} required><option value="">Select statement</option>{STATEMENTS.map((statement) => <option key={statement}>{statement}</option>)}</select></Field>}
                        </div>
                        <div className="form-grid two-col">
                          <Field label={item.type === "Others" ? "Statement" : "More statement (optional)"}>{item.type === "Others" ? <select value={item.statement} onChange={(event) => updateItem(index, { statement: event.target.value })} required><option value="">Select statement</option>{STATEMENTS.map((statement) => <option key={statement}>{statement}</option>)}</select> : <input value={item.detail} onChange={(event) => updateItem(index, { detail: event.target.value })} placeholder="Additional details" maxLength={180} />}</Field>
                          <Field label="Payment mode" required><select value={item.payment} onChange={(event) => updateItem(index, { payment: event.target.value as Payment })} required><option value="">Select payment</option>{PAYMENTS.map((payment) => <option key={payment}>{payment}</option>)}</select></Field>
                        </div>
                        <div className="item-options">
                          <Field label="Collector"><select value={item.collector} onChange={(event) => updateItem(index, { collector: event.target.value })}><option value="">Not specified</option><option value="__depositor">Same as depositor</option><option value="__custom">Other…</option></select></Field>
                          {item.collector === "__custom" && <Field label="Collector name"><input value={item.collectorName ?? ""} onChange={(event) => updateItem(index, { collectorName: event.target.value })} placeholder="Enter collector" maxLength={100} /></Field>}
                          <div className="checks-inline"><label className="check-label"><input type="checkbox" checked={item.completed} onChange={(event) => updateItem(index, { completed: event.target.checked, completedAt: event.target.checked ? new Date().toISOString() : "" })} /><span>Completed</span></label></div>
                        </div>
                      </fieldset>)}
                    </div>
                    <div className="form-end">
                      <button type="button" className="button button-outline" onClick={() => setItems((current) => [...current, emptyItem()])}>＋ Add another item</button>
                      <label className="check-label complete-all"><input type="checkbox" checked={completeAll} onChange={(event) => { const checked = event.target.checked; setItems((current) => current.map((item) => ({ ...item, completed: checked, completedAt: checked ? item.completedAt || new Date().toISOString() : "" }))); }} /><span>Mark all items completed</span></label>
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="button button-primary" disabled={!!label.trim() && blockedLabels.has(normalizeLabel(label))}>Save entry</button>
                      <button type="button" className="button button-quiet" onClick={resetForm}>Clear form</button>
                    </div>
                  </form>}
                </section>

                <section className="panel records-panel" aria-labelledby="today-records-heading">
                  <div className="panel-heading records-heading"><div><p className="eyebrow">Live register</p><h2 id="today-records-heading">Today’s records <span className="count-badge">{displayedToday.length}</span></h2></div><button type="button" className="button button-quiet compact" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>☷ Filter</button></div>
                  <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search today's records" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search depositor, label, item…" /><kbd>/</kbd></label>
                  <p className="muted pin-count">{activePinnedIds.length}/5 entries pinned · Pinned matching entries appear first.</p>
                  <AnimatePresence initial={false}>
                    {showFilters && <motion.div className="filter-grid" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: motionDuration }}>
                      <Field label="Item"><select value={filters.item} onChange={(event) => setFilters({ ...filters, item: event.target.value })}><option value="">All items</option>{ITEM_TYPES.map((type) => <option key={type}>{type === "Others" ? "Other" : type}</option>)}</select></Field>
                      <Field label="Payment"><select value={filters.payment} onChange={(event) => setFilters({ ...filters, payment: event.target.value })}><option value="">All payments</option>{PAYMENTS.map((payment) => <option key={payment}>{payment}</option>)}</select></Field>
                      <Field label="Status"><select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option><option>Pending</option><option>Completed</option></select></Field>
                      <button type="button" className="text-button clear-filters" onClick={() => setFilters({ item: "", payment: "", status: "" })}>Clear filters</button>
                    </motion.div>}
                  </AnimatePresence>
                  <TodayTable records={sortedTodayRecords.filter((record) => matchingItems(record, search, filters).length > 0)} allRecords={records} visibleItems={(record) => matchingItems(record, search, filters)} editingId={inlineEditingId} pinnedIds={activePinnedIds} onTogglePin={togglePinned} onEdit={startInlineEdit} onSaveEdit={saveInlineEdit} onCancelEdit={() => setInlineEditingId(null)} onDelete={deleteRecord} onToggle={toggleCompleted} onPayment={changePayment} onResolveConflict={resolveEntryConflict} />
                </section>
              </div>
              <div className="data-footnote"><span className="privacy-dot" /> Data stays in this browser. Download a JSON backup regularly to keep a portable copy.</div>
            </motion.div>
          ) : (
            <motion.div key="history" initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: motionDuration }}>
              <section className="section-heading">
                <div><p className="eyebrow">Long-term register</p><h1>All records</h1><p className="muted">Every saved day, grouped chronologically. Records stay until you delete them.</p></div>
                <button type="button" className="button button-outline" onClick={() => void printReport("all")}>Download all-data PDF</button>
              </section>
              <section className="panel history-panel">
                <div className="history-tools">
                  <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search all records" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search all records…" /></label>
                  <Field label="Item type"><select value={historyFilters.item} onChange={(event) => setHistoryFilters({ ...historyFilters, item: event.target.value })}><option value="">All items</option>{ITEM_TYPES.map((type) => <option key={type}>{type === "Others" ? "Other" : type}</option>)}</select></Field>
                  <Field label="Payment mode"><select value={historyFilters.payment} onChange={(event) => setHistoryFilters({ ...historyFilters, payment: event.target.value })}><option value="">All payments</option>{PAYMENTS.map((payment) => <option key={payment}>{payment}</option>)}</select></Field>
                  <Field label="Status"><select value={historyFilters.status} onChange={(event) => setHistoryFilters({ ...historyFilters, status: event.target.value })}><option value="">All statuses</option><option>Pending</option><option>Completed</option></select></Field>
                  <p className="muted history-count">{historyRecords.length} {historyRecords.length === 1 ? "entry" : "entries"}</p>
                </div>
                <p className="muted pin-count">{activePinnedIds.length}/5 entries pinned · Pinned matching entries appear first.</p>
                {historyRecords.length === 0 ? <EmptyState title={records.length ? "No matching records" : "No records yet"} detail={records.length ? "Try a different search or payment filter." : "Saved entries will appear here, grouped by date."} /> : <div className="history-groups">
                  {pinnedHistoryRecords.length > 0 && <section className="history-day pinned-records">
                    <div className="history-day-heading"><h2>Pinned entries</h2><span>{pinnedHistoryRecords.length} of 5</span></div>
                    <RecordList records={pinnedHistoryRecords} allRecords={records} visibleItems={(record) => matchingItems(record, historySearch, historyFilters)} editingId={inlineEditingId} pinnedIds={activePinnedIds} onTogglePin={togglePinned} onEdit={startInlineEdit} onSaveEdit={saveInlineEdit} onCancelEdit={() => setInlineEditingId(null)} onDelete={deleteRecord} onToggle={toggleCompleted} onPayment={changePayment} onResolveConflict={resolveEntryConflict} showDate />
                  </section>}
                  {Object.entries(historyGroups).map(([date, group]) => <section key={date} className="history-day">
                    <div className="history-day-heading"><h2>{formatDate(date)}</h2><span>{group.length} {group.length === 1 ? "entry" : "entries"}</span></div>
                    <ItemTypeCounts counts={countItemTypes(group, (record) => matchingItems(record, historySearch, historyFilters))} className="history-type-counts" />
                    <RecordList records={group} allRecords={records} visibleItems={(record) => matchingItems(record, historySearch, historyFilters)} editingId={inlineEditingId} pinnedIds={activePinnedIds} onTogglePin={togglePinned} onEdit={startInlineEdit} onSaveEdit={saveInlineEdit} onCancelEdit={() => setInlineEditingId(null)} onDelete={deleteRecord} onToggle={toggleCompleted} onPayment={changePayment} onResolveConflict={resolveEntryConflict} showDate />
                  </section>)}
                </div>}
              </section>
            </motion.div>
          )}
        </AnimatePresence>

        <footer className="app-footer"><span>Daily Data Logger</span><span>Local-first by design</span></footer>
      </div>
      {workspaceDialog && <WorkspaceDialog
        busy={busy}
        error={errorMessage}
        configured={supabaseConfigured}
        initialMode={workspaceMode}
        onModeChange={setWorkspaceMode}
        onClose={() => setWorkspaceDialog(false)}
        onSubmit={connectWorkspace}
      />}
      <AnimatePresence>
        {toast && <motion.div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} aria-live={toast.kind === "error" ? "assertive" : "polite"} initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : 8 }} transition={{ duration: motionDuration }}>
          <span className="toast-icon">{toast.kind === "error" ? "!" : "✓"}</span><span>{toast.message}</span>{toast.undo && <button type="button" className="undo-button" onClick={undoDelete}>Undo</button>}<button type="button" aria-label="Dismiss notification" className="toast-close" onClick={() => setToast(null)}>×</button>
        </motion.div>}
      </AnimatePresence>
    </main>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <label className="field"><span>{label}{required && <span className="required-mark" aria-label="required"> *</span>}</span>{children}</label>;
}

function StatCard({ label, value, foot, tone }: { label: string; value: number; foot: string; tone: string }) {
  return <article className={`stat-card ${tone}`}><div className="stat-top"><span>{label}</span><span className="stat-orb" aria-hidden="true" /></div><strong>{value}</strong><small>{foot}</small></article>;
}

function ItemTypeCounts({ counts, className }: {
  counts: { type: string; count: number }[];
  className: string;
}) {
  return <div className={`item-type-counts ${className}`} aria-label="Item counts by type">
    <span className="item-type-count-label">By item type</span>
    {counts.map(({ type, count }) => <span className="item-type-count" key={type}>{type}: <strong>{count}</strong></span>)}
  </div>;
}

function DepositorSuggestions({ records, value, onChoose }: {
  records: LogRecord[];
  value: string;
  onChoose: (record: LogRecord) => void;
}) {
  const suggestions = similarDepositors(records, value);
  if (!suggestions.length) return null;
  return <div className="depositor-suggestions" role="group" aria-label="Existing depositor suggestions">
    <span>Existing names <small>Select a name to reuse its latest entry details.</small></span>
    {suggestions.map((record) => <button key={record.id} type="button" className="suggestion-chip" onClick={() => onChoose(record)}>{record.depositor}</button>)}
  </div>;
}

function InlineRecordEditor({ record, allRecords, onSave, onCancel }: {
  record: LogRecord;
  allRecords: LogRecord[];
  onSave: (changes: Pick<LogRecord, "depositor" | "label" | "items">) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [depositor, setDepositor] = useState(record.depositor);
  const [label, setLabel] = useState(record.label);
  const [items, setItems] = useState(() => record.items.map((item) => ({ ...item })));
  const [saving, setSaving] = useState(false);

  const updateItem = (itemId: string, patch: Partial<RecordItem>) => {
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...patch } : item));
  };

  const loadExistingRecord = (source: LogRecord) => {
    setDepositor(source.depositor);
    setLabel(source.label);
    setItems(source.items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      detail: item.type === "Others" ? item.detail.replace(/^Other item: /, "") : item.detail,
    })));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        depositor,
        label,
        items: items.map((item) => ({
          ...item,
          detail: item.type === "Others"
            ? `Other item: ${item.detail.replace(/^Other item: /, "").trim()}`
            : item.detail,
        })),
      });
    } finally {
      setSaving(false);
    }
  };

  return <form className="inline-editor" onSubmit={(event) => void submit(event)}>
    <div className="form-grid two-col">
    <div className="field-with-suggestions"><Field label="Depositor name" required><input value={depositor} onChange={(event) => setDepositor(event.target.value)} maxLength={100} required autoComplete="off" /></Field><DepositorSuggestions records={allRecords} value={depositor} onChoose={loadExistingRecord} /></div>
      <Field label="Label (optional)"><input type="number" min={1} max={10000} step={1} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="1–10000" /></Field>
    </div>
    <div className="items-heading"><h3>Items <span className="count-badge">{items.length}</span></h3></div>
    <div className="item-stack">
      {items.map((item, index) => <fieldset className="item-card" key={item.id}>
        <legend>Item {index + 1}</legend>
        {items.length > 1 && <button type="button" className="remove-item" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`Remove item ${index + 1}`}>×</button>}
        <div className="form-grid two-col">
          <Field label="Item type" required><select value={item.type} onChange={(event) => updateItem(item.id, { type: event.target.value, detail: event.target.value === "Others" ? "Other item: " : "" })} required>{ITEM_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field>
          <Field label="Statement" required><select value={item.statement} onChange={(event) => updateItem(item.id, { statement: event.target.value })} required>{STATEMENTS.map((statement) => <option key={statement}>{statement}</option>)}</select></Field>
        </div>
        {item.type === "Others" && <div className="form-grid"><Field label="Custom item" required><input value={item.detail.replace(/^Other item: /, "")} onChange={(event) => updateItem(item.id, { detail: `Other item: ${event.target.value}` })} maxLength={100} required /></Field></div>}
        {item.type !== "Others" && <div className="form-grid"><Field label="Additional details"><input value={item.detail} onChange={(event) => updateItem(item.id, { detail: event.target.value })} maxLength={180} /></Field></div>}
        <div className="form-grid two-col">
          <Field label="Payment mode" required><select value={item.payment} onChange={(event) => updateItem(item.id, { payment: event.target.value as Payment })} required>{PAYMENTS.map((payment) => <option key={payment}>{payment}</option>)}</select></Field>
          <Field label="Collector"><input value={item.collector === "__depositor" ? depositor : item.collector} onChange={(event) => updateItem(item.id, { collector: event.target.value })} maxLength={100} /></Field>
        </div>
        <div className="checks-inline">
          <label className="check-label"><input type="checkbox" checked={item.completed} onChange={(event) => updateItem(item.id, { completed: event.target.checked, completedAt: event.target.checked ? item.completedAt || new Date().toISOString() : "" })} /><span>Completed</span></label>
        </div>
      </fieldset>)}
    </div>
    <div className="form-end"><button type="button" className="button button-outline compact" onClick={() => setItems((current) => [...current, {
      id: crypto.randomUUID(),
      type: "Powerbank",
      statement: "None",
      detail: "",
      payment: "Not Yet",
      collector: "",
      checkedIn: false,
      completed: false,
      completedAt: "",
    }])}>＋ Add another item</button></div>
    <div className="form-actions">
      <button type="submit" className="button button-primary compact" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
      <button type="button" className="button button-quiet compact" onClick={onCancel} disabled={saving}>Cancel</button>
    </div>
  </form>;
}

function PaymentControl({ payment, disabled, onChange }: {
  payment: Payment;
  disabled: boolean;
  onChange: (payment: Payment) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && !disabled) {
    return <select
      className="payment-select"
      aria-label="Change payment"
      autoFocus
      value={payment}
      onBlur={() => setEditing(false)}
      onChange={(event) => {
        const next = event.target.value;
        if (isPayment(next)) onChange(next);
        setEditing(false);
      }}
    >
      {PAYMENTS.map((option) => <option key={option}>{option}</option>)}
    </select>;
  }
  return <button
    type="button"
    className={`pill payment-button ${payment === "Credit" || payment === "Not Yet" || payment === "None" ? "pill-amber" : "pill-neutral"}`}
    disabled={disabled}
    onClick={() => setEditing(true)}
    aria-label={`Payment: ${payment}. Click to change`}
    title="Click to change payment"
  >{payment}</button>;
}

function TodayTable({ records, allRecords, visibleItems, editingId, pinnedIds, onTogglePin, onEdit, onSaveEdit, onCancelEdit, onDelete, onToggle, onPayment, onResolveConflict }: {
  records: LogRecord[];
  allRecords: LogRecord[];
  visibleItems: (record: LogRecord) => RecordItem[];
  editingId: string | null;
  pinnedIds: string[];
  onTogglePin: (record: LogRecord) => void;
  onEdit: (record: LogRecord) => void;
  onSaveEdit: (record: LogRecord, changes: Pick<LogRecord, "depositor" | "label" | "items">) => Promise<boolean>;
  onCancelEdit: () => void;
  onDelete: (record: LogRecord) => void;
  onToggle: (record: LogRecord, itemId: string) => void;
  onPayment: (record: LogRecord, itemId: string, payment: Payment) => void;
  onResolveConflict: (record: LogRecord, choice: "local" | "server") => void;
}) {
  if (!records.length) return <EmptyState title="Nothing to show" detail="Try changing your search or filters, or add a new entry." />;
  return <div className="table-wrap" role="region" aria-label="Today's records table" tabIndex={0}>
    <table className="records-table">
      <thead><tr><th scope="col">Label</th><th scope="col">Depositor</th><th scope="col">Item</th><th scope="col">Statement</th><th scope="col">Payment</th><th scope="col">Collector</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody>{records.flatMap((record) => {
        if (editingId === record.id) return [<tr key={record.id}><td colSpan={8}><InlineRecordEditor record={record} allRecords={allRecords} onSave={(changes) => onSaveEdit(record, changes)} onCancel={onCancelEdit} /></td></tr>];
        const items = visibleItems(record);
        return items.map((item, index) => <tr key={`${record.id}-${item.id}`}>
          {index === 0 && <><td rowSpan={items.length}><span className="table-label">{record.label || "—"}</span><small>{formatTime(record.createdAt)}</small></td>
            <td rowSpan={items.length}><strong>{record.depositor}</strong></td></>}
          <td>{displayType(item)}</td>
          <td>{item.statement}{item.detail && !item.detail.startsWith("Other item: ") && <small>{item.detail}</small>}</td>
          <td><PaymentControl payment={item.payment} disabled={record.syncState === "conflict"} onChange={(payment) => void onPayment(record, item.id, payment)} /></td>
          <td>{item.collector || "—"}</td>
          <td><button type="button" className={`status-toggle ${item.completed ? "complete" : "pending"}`} disabled={record.syncState === "conflict"} onClick={() => void onToggle(record, item.id)} aria-label={`${item.completed ? "Mark pending" : "Mark complete"}: ${displayType(item)}`}>{item.completed ? "✓ Done" : "○ Pending"}</button>{item.completed && item.completedAt && <small className="completed-time">Done at {formatTime(item.completedAt)}</small>}</td>
          {index === 0 && <td rowSpan={items.length}>{record.syncState !== "conflict" && <div className="table-actions"><button type="button" className={`text-button ${pinnedIds.includes(record.id) ? "pin-active" : ""}`} onClick={() => void onTogglePin(record)} aria-pressed={pinnedIds.includes(record.id)}>{pinnedIds.includes(record.id) ? "★ Pinned" : "☆ Pin"}</button><button type="button" className="text-button" onClick={() => onEdit(record)}>Edit</button><button type="button" className="text-button danger-text" onClick={() => { if (window.confirm(`Delete the entry for ${record.depositor}? You can undo this right after.`)) void onDelete(record); }}>Delete</button></div>}{record.syncState === "conflict" && <div className="conflict-actions"><span className="sync-chip">Conflict</span><button type="button" className="text-button" onClick={() => void onResolveConflict(record, "server")}>Use shared</button><button type="button" className="text-button" onClick={() => void onResolveConflict(record, "local")}>Keep mine</button></div>}</td>}
        </tr>);
      })}</tbody>
    </table>
  </div>;
}

function RecordList({ records, allRecords, visibleItems, editingId, pinnedIds, onTogglePin, onEdit, onSaveEdit, onCancelEdit, onDelete, onToggle, onPayment, onResolveConflict, showDate = false }: {
  records: LogRecord[];
  allRecords: LogRecord[];
  visibleItems: (record: LogRecord) => RecordItem[];
  editingId: string | null;
  pinnedIds: string[];
  onTogglePin: (record: LogRecord) => void;
  onEdit: (record: LogRecord) => void;
  onSaveEdit: (record: LogRecord, changes: Pick<LogRecord, "depositor" | "label" | "items">) => Promise<boolean>;
  onCancelEdit: () => void;
  onDelete: (record: LogRecord) => void;
  onToggle: (record: LogRecord, itemId: string) => void;
  onPayment: (record: LogRecord, itemId: string, payment: Payment) => void;
  onResolveConflict: (record: LogRecord, choice: "local" | "server") => void;
  showDate?: boolean;
}) {
  if (!records.length) return <EmptyState title="Nothing to show" detail="Try changing your search or filters, or add a new entry." />;
  return <div className="record-list">
    {records.map((record) => <article className="record-card" key={record.id}>
      <div className="record-top">
        <div className="record-person"><span className="avatar">{record.depositor.trim().charAt(0).toUpperCase()}</span><div><strong>{record.depositor}</strong><small>Label {record.label || "—"}{showDate ? ` · ${formatDate(record.date, { month: "short", day: "numeric" })}` : ""} · {formatTime(record.createdAt)}</small></div></div>
        <div className="record-actions">
          {record.syncState === "pending" && <span className="sync-chip">Waiting to sync</span>}
          {record.syncState === "failed" && <span className="sync-chip sync-failed">Sync failed</span>}
          {record.syncState !== "conflict" && <>{editingId !== record.id && <><button type="button" className={`text-button ${pinnedIds.includes(record.id) ? "pin-active" : ""}`} onClick={() => void onTogglePin(record)} aria-pressed={pinnedIds.includes(record.id)}>{pinnedIds.includes(record.id) ? "★ Pinned" : "☆ Pin"}</button><button type="button" className="text-button" onClick={() => onEdit(record)}>Edit</button></>}<button type="button" className="text-button danger-text" onClick={() => { if (window.confirm(`Delete the entry for ${record.depositor}? You can undo this right after.`)) void onDelete(record); }}>Delete</button></>}
        </div>
      </div>
      {record.syncState === "conflict" && <div className="conflict-box">
        <span>This entry changed on another device. Choose which version to keep.</span>
        <button type="button" className="button button-outline compact" onClick={() => void onResolveConflict(record, "server")}>Use shared version</button>
        <button type="button" className="button button-primary compact" onClick={() => void onResolveConflict(record, "local")}>Keep my version</button>
      </div>}
      {editingId === record.id
        ? <InlineRecordEditor record={record} allRecords={allRecords} onSave={(changes) => onSaveEdit(record, changes)} onCancel={onCancelEdit} />
        : <div className="record-items">{visibleItems(record).map((item) => <div className="record-item" key={item.id}>
        <div className="item-description"><span className="item-symbol">{displayType(item) === "Phone" ? "◉" : displayType(item) === "Laptop" ? "▱" : "◇"}</span><div><strong>{displayType(item)} <span className="statement">· {item.statement}</span></strong><small>{item.detail && !item.detail.startsWith("Other item: ") ? item.detail : item.detail.startsWith("Other item: ") ? item.detail.slice(12) : "No additional details"}{item.collector ? ` · Collected by ${item.collector.startsWith("custom:") ? item.collector.slice(7) : item.collector === "__depositor" ? record.depositor : item.collector}` : ""}</small></div></div>
        <div className="item-meta"><PaymentControl payment={item.payment} disabled={record.syncState === "conflict"} onChange={(payment) => void onPayment(record, item.id, payment)} /><div className="status-stack"><button type="button" className={`status-toggle ${item.completed ? "complete" : "pending"}`} disabled={record.syncState === "conflict"} onClick={() => void onToggle(record, item.id)} aria-label={`${item.completed ? "Mark pending" : "Mark complete"}: ${displayType(item)}`}>
          <span aria-hidden="true">{item.completed ? "✓" : "○"}</span>{item.completed ? "Done" : "Pending"}
        </button>{item.completed && item.completedAt && <small className="completed-time">Done at {formatTime(item.completedAt)}</small>}</div></div>
      </div>)}</div>}
    </article>)}
  </div>;
}

function WorkspaceDialog({
  busy,
  error,
  configured,
  initialMode,
  onModeChange,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  configured: boolean;
  initialMode: "create" | "join";
  onModeChange: (mode: "create" | "join") => void;
  onClose: () => void;
  onSubmit: (values: { action: "create" | "join"; name: string; code: string }) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const changeMode = (next: "create" | "join") => {
    setMode(next);
    onModeChange(next);
  };

  const generateCode = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    setCode(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  };

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
      <div className="panel-heading">
        <div><p className="eyebrow">OPTIONAL TEAM SYNC</p><h2 id="workspace-dialog-title">{mode === "create" ? "Create a workspace" : "Connect to a workspace"}</h2></div>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}>×</button>
      </div>
      <p className="dialog-copy">Records stay in IndexedDB on this device first. Sharing local records is a separate, explicit action.</p>
      <div className="dialog-mode" role="group" aria-label="Workspace action">
        <button type="button" className={mode === "join" ? "active" : ""} onClick={() => changeMode("join")}>Join existing</button>
        <button type="button" className={mode === "create" ? "active" : ""} onClick={() => changeMode("create")}>Create new</button>
      </div>
      {!configured && <div className="notice notice-warning">To enable team sync, configure a Supabase project and deploy this app’s database migration and workspace-access function.</div>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <form onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ action: mode, name, code });
      }}>
        {mode === "create" && <Field label="Workspace name" required><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="e.g. Front desk" /></Field>}
        <Field label="Shared access code (12+ characters)" required>
          <div className="code-input-row">
            <input type="password" value={code} onChange={(event) => setCode(event.target.value)} required minLength={12} maxLength={128} autoComplete="off" placeholder="Use a strong private passphrase" />
            {mode === "create" && <button type="button" className="button button-outline compact" onClick={generateCode}>Generate</button>}
          </div>
        </Field>
        <p className="dialog-warning">Anyone with this code can access, edit, and delete shared records. Share it only with trusted team members. This workspace has no individual user roles.</p>
        <div className="form-actions">
          <button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={busy || !configured}>{busy ? "Connecting…" : mode === "create" ? "Create workspace" : "Connect device"}</button>
        </div>
      </form>
    </section>
  </div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon" aria-hidden="true">⌁</span><strong>{title}</strong><p>{detail}</p></div>;
}

export default App;
