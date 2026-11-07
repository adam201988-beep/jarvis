export const TASK_MAX: number
export function normalizeTask(raw: unknown): string
export function taskAllowed(
  raw: unknown,
): { ok: true; task: string } | { ok: false; reason: string }
