/**
 * Every step of an update, written down.
 *
 * An update that goes wrong goes wrong on someone else's machine, days later, with nothing to look
 * at: electron-updater logs to a console no packaged app has. Reported on a colleague's PC — the app
 * was gone after an automatic update — and there was no way to tell which step had failed. So the
 * library's own log goes to a file beside the app's other state, small and plain, kept across
 * restarts and trimmed when it grows.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { homePaths } from "../core/paths.js";

/** Past this, the file is rolled over to `.old`; one rollover is kept. */
const MAX_BYTES = 256 * 1024;

export interface UpdateLogger {
  info: (message: unknown) => void;
  warn: (message: unknown) => void;
  error: (message: unknown) => void;
  debug: (message: unknown) => void;
}

function line(level: string, message: unknown): string {
  const text = message instanceof Error ? `${message.message}\n${message.stack ?? ""}` : String(message);
  return `${new Date().toISOString()} ${level} ${text}\n`;
}

/** The logger electron-updater takes; writing is best effort and never throws into the update. */
export function updateLogger(file = homePaths().hangarUpdateLog): UpdateLogger {
  const write = (level: string, message: unknown): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`);
      } catch {
        // No file yet, or a rollover we could not do: either way, keep writing.
      }
      appendFileSync(file, line(level, message), "utf8");
    } catch {
      // A log we cannot write is not a reason to fail an update.
    }
  };
  return {
    info: (message) => write("info ", message),
    warn: (message) => write("warn ", message),
    error: (message) => write("error", message),
    debug: (message) => write("debug", message),
  };
}
