#!/usr/bin/env pnpm exec tsx
/**
 * X update-list — change a list's name, description, and/or privacy via
 * its Edit List dialog. Only fields that are passed are touched.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';
import { fetchMyLists, LISTS_READ_FAILED, openEditListDialog, resolveListId } from '../lib/lists.js';

interface Input { list: string; name?: string | null; description?: string | null; private?: boolean | null }

async function updateList(input: Input): Promise<ScriptResult> {
  if (!input.list) return { success: false, message: 'list required.' };
  const name = input.name == null ? null : input.name.trim();
  const description = input.description == null ? null : input.description.trim();
  const makePrivate = input.private ?? null;
  if (name === null && description === null && makePrivate === null) {
    return { success: false, message: 'Nothing to change — pass name, description, and/or private.' };
  }
  if (name !== null && (name.length === 0 || name.length > config.limits.listNameMaxLength)) {
    return { success: false, message: `List name must be 1–${config.limits.listNameMaxLength} characters.` };
  }
  if (description !== null && description.length > config.limits.listDescriptionMaxLength) {
    return { success: false, message: `List description exceeds ${config.limits.listDescriptionMaxLength} characters (current: ${description.length}).` };
  }

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);
    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const resolved = await resolveListId(page, input.list);
    if ('error' in resolved) return { success: false, message: resolved.error };
    const { id } = resolved;

    if (name !== null) {
      const mine = await fetchMyLists(page);
      if (!mine) return { success: false, message: LISTS_READ_FAILED };
      const dup = mine.lists.find((l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase());
      if (dup) return { success: false, message: `You already have another list named "${dup.name}" (${dup.url}). Pick a different name.` };
    }

    const nameInput = page.locator(X_SELECTORS.listNameInput);
    if (!(await openEditListDialog(page, id))) {
      await captureFailure(page, 'update-list-no-dialog');
      return { success: false, message: `Couldn't open the Edit List dialog for ${X_URLS.list(id)} — it may not exist or may not be one of your lists.` };
    }
    const oldName = await nameInput.inputValue();

    if (name !== null) await nameInput.fill(name);
    if (description !== null) await page.locator(X_SELECTORS.listDescriptionInput).fill(description);
    if (makePrivate !== null) await page.locator(X_SELECTORS.listPrivateCheckbox).setChecked(makePrivate);
    await page.waitForTimeout(config.timeouts.afterFill);

    const done = page.locator(X_SELECTORS.listEditDoneButton);
    if (await done.isDisabled()) {
      return { success: true, message: `List "${oldName}" already matches — nothing to change (no-op).` };
    }
    await done.click();
    await page.waitForTimeout(config.timeouts.afterSubmit);

    // Verify by reopening the dialog and reading the fields back.
    if (!(await openEditListDialog(page, id))) {
      await captureFailure(page, 'update-list-reopen');
      return { success: false, message: `Saved, but couldn't reopen the list to confirm. Check ${X_URLS.list(id)} by hand.` };
    }
    const now = {
      name: await nameInput.inputValue(),
      description: await page.locator(X_SELECTORS.listDescriptionInput).inputValue(),
      private: await page.locator(X_SELECTORS.listPrivateCheckbox).isChecked(),
    };
    const mismatch =
      (name !== null && now.name !== name) ||
      (description !== null && now.description !== description) ||
      (makePrivate !== null && now.private !== makePrivate);
    if (mismatch) {
      await captureFailure(page, 'update-list-no-verify');
      return { success: false, message: `Saved, but the list doesn't show the new values yet (now: name "${now.name}", ${now.private ? 'private' : 'public'}). Verify manually.` };
    }
    return {
      success: true,
      message: `Updated list ${X_URLS.list(id)} — name "${now.name}", ${now.private ? 'private' : 'public'}${now.description ? `, description "${now.description}"` : ', no description'}.`,
      data: { id, ...now, url: X_URLS.list(id) },
    };
  } catch (err) {
    await captureFailure(page, 'update-list-error');
    return { success: false, message: `update-list error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(updateList);
