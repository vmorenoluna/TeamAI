/**
 * Parse "resets 4:30pm (UTC)" from Claude Code's session-limit message.
 * Returns a Unix timestamp (seconds) for the reset time, or null if unparseable.
 *
 * Used by both the orchestrator (server) and roadmap-view (client) for
 * consistent rate-limit auto-resume logic.
 */
export function parseSessionLimitReset(line: string): number | null {
  const m = line.match(/resets\s+(\d+):(\d+)\s*(am|pm)\s*(?:\(UTC\))?/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  // Reject invalid 12-hour clock values
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  const now = new Date();
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours,
    minutes,
    0,
  ));
  // If the reset time is already in the past today, it must be tomorrow
  if (reset.getTime() <= Date.now()) reset.setUTCDate(reset.getUTCDate() + 1);
  return Math.floor(reset.getTime() / 1000);
}

/**
 * Format a Unix timestamp (seconds) as a human-readable countdown.
 * Returns mm:ss if under an hour, else Hh Mm.
 */
export function formatCountdown(resetsAtSec: number): string {
  const diffMs = Math.max(resetsAtSec * 1000 - Date.now(), 0);
  const totalSec = Math.ceil(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}:${String(secs).padStart(2, '0')}`;
  return `${secs}s`;
}
