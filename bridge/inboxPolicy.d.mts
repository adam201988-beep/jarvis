export function taskAllowed(
  raw: string,
): { ok: true; task: string } | { ok: false; reason: string }
