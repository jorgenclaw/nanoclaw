#!/usr/bin/env pnpm exec tsx
/**
 * X read-my-lists — the logged-in user's own lists (name, URL, privacy,
 * member count). Gives the agent the list URLs it needs for
 * x_update_list / x_edit_list_members / x_read_list.
 */

import { getBrowserContext, runScript, ScriptResult, ensureLoggedIn, captureFailure, config } from '../lib/browser.js';
import { X_URLS } from '../lib/locators.js';
import { fetchMyLists, LISTS_READ_FAILED, renderLists } from '../lib/lists.js';

type Input = Record<string, never>;

async function readMyLists(_input: Input): Promise<ScriptResult> {
  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);
    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const result = await fetchMyLists(page);
    if (!result) {
      await captureFailure(page, 'read-my-lists-no-handle');
      return { success: false, message: LISTS_READ_FAILED };
    }
    return {
      success: true,
      message: renderLists(result.lists, `Your X lists (@${result.handle}) — ${result.lists.length}:`),
      data: result.lists,
    };
  } catch (err) {
    await captureFailure(page, 'read-my-lists-error');
    return { success: false, message: `read-my-lists error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readMyLists);
