/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];
const SETUP_TIMEOUT_MS = 90_000;

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  // Run adapter setups concurrently so a slow or hung adapter cannot block the
  // rest of the chain. Each adapter also has its own setup timeout — without it,
  // a permanent hang in one adapter's setup() would leave the returned Promise
  // pending forever and block host startup.
  const startups = [...registry].map(async ([name, registration]) => {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        return;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await withTimeout(
            adapter.setup(setup),
            SETUP_TIMEOUT_MS,
            `Channel adapter ${name} setup timed out after ${SETUP_TIMEOUT_MS}ms`,
          );
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      activeAdapters.set(adapter.channelType, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  });
  await Promise.allSettled(startups);
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
