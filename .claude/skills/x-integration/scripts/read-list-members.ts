#!/usr/bin/env pnpm exec tsx
/**
 * X read-list-members — who is on a list. Accepts a list URL/ID, or the
 * exact name of one of the user's own lists.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_URLS } from '../lib/locators.js';
import { resolveListId } from '../lib/lists.js';

interface Input { list: string; limit?: number }

interface Member { handle: string; name: string }

async function readListMembers(input: Input): Promise<ScriptResult> {
  if (!input.list) return { success: false, message: 'list required.' };
  const limit = Math.min(input.limit ?? 50, config.limits.listMembersReadMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);
    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const resolved = await resolveListId(page, input.list);
    if ('error' in resolved) return { success: false, message: resolved.error };

    await page.goto(X_URLS.listMembers(resolved.id), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Owner view opens as a modal; other people's lists render in the main
    // column. Scope to whichever is there so sidebar "Who to follow" cells
    // never leak in.
    const inDialog = await page.locator('[role="dialog"] [data-testid="UserCell"]').first().isVisible().catch(() => false);
    const cellSel = inDialog ? '[role="dialog"] [data-testid="UserCell"]' : '[data-testid="primaryColumn"] [data-testid="UserCell"]';

    const members = new Map<string, Member>();
    let stagnant = 0;
    while (members.size < limit && stagnant < 3) {
      const before = members.size;
      const texts = await page.locator(cellSel).allInnerTexts();
      for (const t of texts) {
        const handle = t.match(/@(\w{1,15})/)?.[1];
        if (handle && !members.has(handle.toLowerCase())) {
          members.set(handle.toLowerCase(), { handle, name: t.split('\n')[0].trim() });
        }
      }
      stagnant = members.size === before ? stagnant + 1 : 0;
      await page.locator(cellSel).last().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(1500);
    }

    const list = [...members.values()].slice(0, limit);
    if (list.length === 0) {
      return { success: true, message: `List ${X_URLS.list(resolved.id)} has no members (or they couldn't be loaded).`, data: [] };
    }
    return {
      success: true,
      message: `Members of ${X_URLS.list(resolved.id)} — ${list.length}${members.size >= limit ? ' (limit reached)' : ''}:\n` +
        list.map((m) => `- @${m.handle} (${m.name})`).join('\n'),
      data: list,
    };
  } catch (err) {
    await captureFailure(page, 'read-list-members-error');
    return { success: false, message: `read-list-members error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readListMembers);
