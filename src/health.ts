import { log } from './log.js';

const DEDUP_WINDOW_MS = 60 * 60 * 1000;
const lastAlerted = new Map<string, number>();

let sendAlertFn: ((text: string) => Promise<void>) | undefined;

export function initHealthMonitor(opts: { sendAlert: (text: string) => Promise<void> }): void {
  sendAlertFn = opts.sendAlert;
  log.info('Health monitor initialized');
}

export async function reportError(category: string, message: string, details?: Record<string, unknown>): Promise<void> {
  log.error(`[health] ${message}`, { category, ...details });

  if (!sendAlertFn) return;

  const now = Date.now();
  const lastTime = lastAlerted.get(category) || 0;
  if (now - lastTime < DEDUP_WINDOW_MS) return;

  lastAlerted.set(category, now);

  try {
    await sendAlertFn(`⚠️ NanoClaw Health Alert\n\n*${category}*\n${message}`);
  } catch (err) {
    log.error('Failed to send health alert', { err, category });
  }
}

export function clearAlert(category: string): void {
  lastAlerted.delete(category);
}
