import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The host-side registry of factory tasks.
 *
 * @remarks
 * Docker labels are immutable, so they cannot carry a heartbeat. The
 * registry does: one small JSON file per task under `.factory/tasks/`, with
 * the task's status and the last time something happened in it.
 *
 * The janitor reads it to decide what is still alive. The pipeline writes it
 * when a task starts, when a sandbox opens, and when the task reaches a
 * terminal state.
 */

/** Where the registry lives, relative to the app root. */
const TASKS_DIR = ".factory/tasks";

export type TaskStatus =
  | "running"
  | "iterating"
  | "completed"
  | "failed"
  | "cancelled"
  | "escalated";

/** A task that is over. Nothing of it needs to survive. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "escalated",
];

export interface TaskRecord {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  /** Last time a sandbox of this task did something. */
  readonly lastHeartbeatAt: string;
  /** Sandboxes this task opened. */
  readonly sandboxes: readonly string[];
}

function registryRoot(): string {
  // The app root is the process working directory: eve runs the app from
  // `apps/ia-factory`, and the registry belongs to the app, not to the repo.
  return process.cwd();
}

function recordPath(taskId: string): string {
  return join(registryRoot(), TASKS_DIR, `${taskId}.json`);
}

/**
 * Reads a task record, or null when the task is unknown.
 */
export async function readTask(
  taskId: string,
): Promise<TaskRecord | null> {
  try {
    const raw = await readFile(recordPath(taskId), "utf8");
    return JSON.parse(raw) as TaskRecord;
  } catch {
    return null;
  }
}

/**
 * Writes a task record.
 */
export async function writeTask(record: TaskRecord): Promise<void> {
  await mkdir(join(registryRoot(), TASKS_DIR), { recursive: true });
  await writeFile(recordPath(record.taskId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * Records that a sandbox of this task is alive.
 *
 * @remarks
 * The heartbeat is what keeps a task from being swept while it is working.
 * It is a touch of a small file, not a lock: two sandboxes of the same task
 * may write at the same time, and the last writer wins.
 */
export async function heartbeat(
  taskId: string,
  sandboxId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await readTask(taskId);
  const sandboxes = new Set(existing?.sandboxes ?? []);
  sandboxes.add(sandboxId);
  await writeTask({
    taskId,
    status: existing?.status ?? "running",
    createdAt: existing?.createdAt ?? now,
    lastHeartbeatAt: now,
    sandboxes: [...sandboxes],
  });
}

/**
 * Moves a task to a new status.
 */
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await readTask(taskId);
  await writeTask({
    taskId,
    status,
    createdAt: existing?.createdAt ?? now,
    lastHeartbeatAt: now,
    sandboxes: existing?.sandboxes ?? [],
  });
}

/**
 * Every task the registry knows about.
 *
 * @remarks
 * A file that does not parse is skipped: a corrupted registry must not stop
 * the janitor from cleaning the rest.
 */
export async function listTasks(): Promise<TaskRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(join(registryRoot(), TASKS_DIR));
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const record = await readTask(entry.replace(/\.json$/, ""));
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}
