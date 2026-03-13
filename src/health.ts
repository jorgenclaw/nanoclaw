/**
 * Health monitor for NanoClaw.
 * Tracks errors and sends deduplicated alerts to the admin via Signal.
 */
import { logger } from './logger.js';
import { Channel } from './types.js';

// Suppress duplicate alerts: only notify once per error type within this window
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const lastAlerted = new Map<string, number>();

let adminJid: string | undefined;
let adminChannel: Channel | undefined;

export function initHealthMonitor(opts: {
  adminJid: string;
  channel: Channel;
}): void {
  adminJid = opts.adminJid;
  adminChannel = opts.channel;
  logger.info('Health monitor initialized');
}

/**
 * Report an error. Sends a Signal alert to the admin if not recently alerted
 * for this error category.
 */
export async function reportError(
  category: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  logger.error({ category, ...details }, `[health] ${message}`);

  if (!adminJid || !adminChannel) return;

  const now = Date.now();
  const lastTime = lastAlerted.get(category) || 0;
  if (now - lastTime < DEDUP_WINDOW_MS) return;

  lastAlerted.set(category, now);

  const text = `⚠️ NanoClaw Health Alert\n\n**${category}**\n${message}`;
  try {
    await adminChannel.sendMessage(adminJid, text);
  } catch (err) {
    logger.error({ err, category }, 'Failed to send health alert');
  }
}

/**
 * Clear the dedup timer for a category (e.g., when the issue is resolved).
 */
export function clearAlert(category: string): void {
  lastAlerted.delete(category);
}
