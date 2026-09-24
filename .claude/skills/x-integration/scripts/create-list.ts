#!/usr/bin/env pnpm exec tsx
/**
 * X create-list — create a new list (name, optional description, public or
 * private). Refuses a name that matches one of the user's existing lists:
 * membership edits find a list by name in X's "Add/remove from Lists"
 * picker, so duplicate names would make those edits ambiguous.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';
import { fetchMyLists, LISTS_READ_FAILED } from '../lib/lists.js';

interface Input { name: string; description?: string | null; private?: boolean }

async function createList(input: Input): Promise<ScriptResult> {
  const name = (input.name ?? '').trim();
  const description = (input.description ?? '').trim();
  if (!name) return { success: false, message: 'name required.' };
  if (name.length > config.limits.listNameMaxLength) {
    return { success: false, message: `List name exceeds ${config.limits.listNameMaxLength} characters (current: ${name.length}).` };
  }
  if (description.length > config.limits.listDescriptionMaxLength) {
    return { success: false, message: `List description exceeds ${config.limits.listDescriptionMaxLength} characters (current: ${description.length}).` };
  }

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);
    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    // No duplicate check without the data — refuse rather than risk a copy.
    const mine = await fetchMyLists(page);
    if (!mine) return { success: false, message: LISTS_READ_FAILED };
    const dup = mine.lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (dup) {
      return { success: false, message: `You already have a list named "${dup.name}": ${dup.url}. Pick a different name, or edit that one with x_update_list.` };
    }

    await page.goto(X_URLS.listCreate, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    const nameInput = page.locator(X_SELECTORS.listNameInput);
    await nameInput.waitFor({ timeout: config.timeouts.navigation });
    await nameInput.fill(name);
    if (description) await page.locator(X_SELECTORS.listDescriptionInput).fill(description);
    if (input.private) await page.locator(X_SELECTORS.listPrivateCheckbox).setChecked(true);
    await page.waitForTimeout(config.timeouts.afterFill);

    await page.locator(X_SELECTORS.listCreateNextButton).click();
    // X moves on to the "add members" step at /i/lists/<new id>/members/suggested.
    const created = await page.waitForURL(/\/i\/lists\/\d+/, { timeout: 15000 }).then(() => true).catch(() => false);
    const m = page.url().match(/\/i\/lists\/(\d+)/);
    if (!created || !m) {
      await captureFailure(page, 'create-list-no-id');
      return { success: false, message: `Clicked Next but X didn't move to the new list — it may not have been created. Check with x_read_my_lists before retrying.` };
    }
    const url = X_URLS.list(m[1]);
    return {
      success: true,
      message: `Created ${input.private ? 'private' : 'public'} list "${name}": ${url}. Add people with x_edit_list_members.`,
      data: { id: m[1], name, url, private: !!input.private },
    };
  } catch (err) {
    await captureFailure(page, 'create-list-error');
    return { success: false, message: `create-list error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(createList);
