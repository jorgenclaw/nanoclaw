#!/usr/bin/env pnpm exec tsx
/**
 * X edit-list-members — add and/or remove people from one of the user's
 * lists. For each handle: open their profile → More (…) → "Add/remove
 * from Lists" → tick or untick the list in the picker → Save. Going
 * through the profile means the person is matched by exact handle (no
 * search-result guessing); the picker only shows list names, so the list
 * is matched by exact name and duplicate names are refused.
 */

import type { Page } from 'playwright-core';
import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';
import { resolveList } from '../lib/lists.js';

interface Input { list: string; add?: string[] | null; remove?: string[] | null }

type Outcome = { handle: string; ok: boolean; text: string };

async function setMembership(page: Page, handle: string, listName: string, member: boolean): Promise<Outcome> {
  const verb = member ? 'add' : 'remove';
  await page.goto(X_URLS.profile(handle), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(config.timeouts.pageLoad);

  const actions = page.locator(X_SELECTORS.userActions);
  if (!(await actions.waitFor({ timeout: config.timeouts.elementWait }).then(() => true).catch(() => false))) {
    return { handle, ok: false, text: `@${handle}: profile not found or unavailable.` };
  }
  await actions.click();
  const menuItem = page.locator('[role="menuitem"]', { hasText: /from Lists/i }).first();
  if (!(await menuItem.waitFor({ timeout: config.timeouts.elementWait }).then(() => true).catch(() => false))) {
    await captureFailure(page, 'list-members-no-menu-item');
    return { handle, ok: false, text: `@${handle}: no "Add/remove from Lists" option on their profile menu.` };
  }
  await menuItem.click();

  const cells = page.locator(X_SELECTORS.listCell);
  await cells.first().waitFor({ timeout: config.timeouts.navigation });
  const cell = cells.filter({ has: page.getByText(listName, { exact: true }) });
  const count = await cell.count();
  if (count !== 1) {
    await captureFailure(page, 'list-members-cell-match');
    return {
      handle,
      ok: false,
      text: count === 0
        ? `@${handle}: list "${listName}" not found in the Lists picker.`
        : `@${handle}: more than one list named "${listName}" — rename one so they're distinct.`,
    };
  }

  const checked = (await cell.getAttribute('aria-checked')) === 'true';
  if (checked === member) {
    await page.locator(X_SELECTORS.dialogClose).first().click().catch(() => {});
    return { handle, ok: true, text: `@${handle}: already ${member ? 'on' : 'not on'} the list (no-op).` };
  }
  await cell.click();
  await page.waitForTimeout(config.timeouts.afterClick);
  if (((await cell.getAttribute('aria-checked')) === 'true') !== member) {
    await captureFailure(page, 'list-members-toggle');
    return { handle, ok: false, text: `@${handle}: clicked the list but it didn't toggle — nothing saved.` };
  }

  const save = page.locator(X_SELECTORS.listPickerSaveButton);
  await save.click();
  const closed = await page.locator(X_SELECTORS.listCell).first()
    .waitFor({ state: 'detached', timeout: 10000 }).then(() => true).catch(() => false);
  if (!closed) {
    await captureFailure(page, 'list-members-save');
    return { handle, ok: false, text: `@${handle}: clicked Save but the picker didn't close — ${verb} may not have saved. Verify with x_read_list_members.` };
  }
  return { handle, ok: true, text: `@${handle}: ${member ? 'added' : 'removed'}.` };
}

function cleanHandles(v: string[] | null | undefined): string[] {
  return (v ?? []).map((h) => String(h).trim().replace(/^@/, '')).filter((h) => h.length > 0);
}

async function editListMembers(input: Input): Promise<ScriptResult> {
  if (!input.list) return { success: false, message: 'list required.' };
  const add = cleanHandles(input.add);
  const remove = cleanHandles(input.remove);
  if (add.length === 0 && remove.length === 0) return { success: false, message: 'Pass at least one handle in add or remove.' };
  const overlap = add.filter((h) => remove.some((r) => r.toLowerCase() === h.toLowerCase()));
  if (overlap.length) return { success: false, message: `Handle(s) in both add and remove: ${overlap.map((h) => '@' + h).join(', ')}.` };
  if (add.length + remove.length > config.limits.listMembersPerCall) {
    return { success: false, message: `At most ${config.limits.listMembersPerCall} handles per call (got ${add.length + remove.length}). Split into several calls.` };
  }

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);
    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const resolved = await resolveList(page, input.list);
    if ('error' in resolved) return { success: false, message: resolved.error };
    const listName = resolved.name;

    const outcomes: Outcome[] = [];
    for (const [handle, member] of [...add.map((h) => [h, true] as const), ...remove.map((h) => [h, false] as const)]) {
      try {
        outcomes.push(await setMembership(page, handle, listName, member));
      } catch (err) {
        await captureFailure(page, 'list-members-error');
        outcomes.push({ handle, ok: false, text: `@${handle}: error — ${err instanceof Error ? err.message : String(err)}` });
      }
      await page.waitForTimeout(1500);
    }

    const failed = outcomes.filter((o) => !o.ok).length;
    const header = failed === 0
      ? `List "${listName}" updated:`
      : `List "${listName}" — ${failed} of ${outcomes.length} change${outcomes.length === 1 ? '' : 's'} failed:`;
    return {
      success: failed === 0,
      message: `${header}\n${outcomes.map((o) => `- ${o.text}`).join('\n')}`,
      data: { list: listName, id: resolved.id, outcomes },
    };
  } catch (err) {
    await captureFailure(page, 'edit-list-members-error');
    return { success: false, message: `edit-list-members error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(editListMembers);
