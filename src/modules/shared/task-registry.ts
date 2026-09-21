export interface TaskRecord {
  taskId: string;
  serverId: string;
  sessionId: string;
  inputId?: string;
  previousIdleAt?: number;
  mutating?: boolean;
  /** Epoch ms when the task was started; used to detect tasks that never produced output. */
  createdAt?: number;
  /**
   * Epoch ms when the task was cancelled. Without it an aborted session whose
   * last assistant message carries a completed timestamp reports `completed`,
   * which is indistinguishable from a task that finished on its own.
   */
  cancelledAt?: number;
}

const tasks = new Map<string, TaskRecord>();

export function registerTask(task: TaskRecord) {
  tasks.set(task.taskId, task);
}

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

/**
 * Record that a task was cancelled. No-ops for an unknown id so callers do not
 * have to re-check the registry after aborting.
 */
export function markTaskCancelled(taskId: string, at: number = Date.now()) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.cancelledAt = at;
}

export function removeTask(taskId: string) {
  tasks.delete(taskId);
}

export function resumeTask(taskId: string, inputId: string, previousIdleAt = 0) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.inputId = inputId;
  task.previousIdleAt = previousIdleAt;
  task.createdAt = Date.now();
  delete task.cancelledAt;
}

export function ownsSession(serverId: string, sessionId: string): boolean {
  return [...tasks.values()].some(
    (task) => task.serverId === serverId && task.sessionId === sessionId,
  );
}
