import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Single-instance connection guard.
 *
 * Two layers:
 *  1. global flag  — catches same-process re-entrant calls (e.g. sub-agents
 *                    spawned inside the same Node.js process, same PID).
 *  2. PID lock file — catches separate-process duplicates (e.g. sub-agents
 *                    launched as child processes with different PIDs).
 *
 * Lock file format: `<pid>:<startTime>:<instanceId>` where startTime is the
 * jiffies-since-boot from /proc/<pid>/stat field 22. The startTime guards
 * against PID-namespace collisions across container restarts — a container
 * restart can reassign the same PID number to a brand new process; without
 * the startTime check `process.kill(pid, 0)` would falsely report the old
 * lock as still held. Legacy 2-field locks (`<pid>:<instanceId>`) are
 * parseable but treated as stale: that format is exactly what *had* the
 * PID-collision bug; one acquire after upgrade rewrites in the new format.
 */

const LOCK_PATH = path.join(os.homedir(), ".pi", "msg-bridge.lock");

const g = global as any;
if (!g.__msgBridgeInstanceId) {
  g.__msgBridgeInstanceId = Math.random().toString(36).slice(2);
}
const instanceId: string = g.__msgBridgeInstanceId;

interface ParsedLock {
  pid: number;
  startTime: string | undefined; // undefined for legacy 2-field locks
  owner: string;
}

function parseLock(raw: string): ParsedLock | undefined {
  const parts = raw.trim().split(":");
  const pid = parseInt(parts[0], 10);
  if (Number.isNaN(pid)) return undefined;
  if (parts.length >= 3) {
    return { pid, startTime: parts[1], owner: parts.slice(2).join(":") };
  }
  return { pid, startTime: undefined, owner: parts[1] ?? "" };
}

/**
 * Read /proc/<pid>/stat field 22 (starttime, jiffies since boot). The `comm`
 * field (parenthesised) may contain spaces or colons, so we anchor on the
 * final ')' before splitting. Returns undefined on any read/parse error or
 * on non-Linux platforms.
 */
function readProcessStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // After ')' the remaining fields are: state(0) ppid(1) ... starttime(19, = field 22)
    return afterComm[19];
  } catch {
    return undefined;
  }
}

export function acquireLock(): boolean {
  // Layer 1: same-process guard via a global flag
  if (g.__msgBridgeConnected && g.__msgBridgeOwner !== instanceId) {
    return false;
  }

  // Layer 2: cross-process guard via PID lock file. The only question that
  // matters is "is the recorded holder a real, live process right now?" —
  // not whether its PID happens to equal ours (it can, after a container
  // restart in a fresh PID namespace), and not whether the owner string
  // happens to differ from ours (every fresh process picks a new random).
  // isLockHolderAlive(parsed) is the single source of truth.
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const parsed = parseLock(fs.readFileSync(LOCK_PATH, "utf-8"));
      if (parsed && isLockHolderAlive(parsed)) {
        return false;
      }
      // Otherwise stale — overwrite below.
    }
    const configDir = path.join(os.homedir(), ".pi");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    const startTime = readProcessStartTime(process.pid) ?? "0";
    fs.writeFileSync(LOCK_PATH, `${process.pid}:${startTime}:${instanceId}`, { mode: 0o600 });
  } catch {
    // lock file mechanics failed — fall through, global flag is still set below
  }

  g.__msgBridgeConnected = true;
  g.__msgBridgeOwner = instanceId;
  return true;
}

/**
 * True iff some live process is the actual owner of the lock. Requires both
 * that the PID exists AND that its /proc start_time matches the value
 * recorded in the lock — defeats PID-namespace collisions across container
 * restarts. Legacy 2-field locks are treated as unconditionally stale: that
 * format is precisely what *had* the PID-collision bug, so trusting them
 * past the upgrade boundary would defeat the point of this fix. One acquire
 * after upgrade re-writes the lock in the new format.
 */
function isLockHolderAlive(parsed: ParsedLock): boolean {
  if (parsed.startTime === undefined) return false;
  try {
    process.kill(parsed.pid, 0);
  } catch {
    return false;
  }
  const currentStartTime = readProcessStartTime(parsed.pid);
  if (currentStartTime === undefined) return false;
  return currentStartTime === parsed.startTime;
}

export function releaseLock(): void {
  if (g.__msgBridgeOwner !== instanceId) return;
  g.__msgBridgeConnected = false;
  g.__msgBridgeOwner = undefined;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const parsed = parseLock(fs.readFileSync(LOCK_PATH, "utf-8"));
      if (parsed && parsed.pid === process.pid && parsed.owner === instanceId) {
        fs.unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // ignore
  }
}
