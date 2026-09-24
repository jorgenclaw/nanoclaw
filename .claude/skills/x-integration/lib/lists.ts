/**
 * Shared helpers for the X list tools (create / update / members / my-lists).
 *
 * Lists are identified two ways by the agent: a list URL / numeric ID, or
 * the list's exact name. The "Add/remove from Lists" picker on a profile
 * only shows names, so membership edits always resolve to a name; the
 * edit dialog needs an ID. resolveList() turns either form into both when
 * it can.
 */

import type { Page } from 'playwright-core';
import { config } from './config.js';
import { X_SELECTORS, X_URLS } from './locators.js';

export const LISTS_READ_FAILED =
  "Couldn't read your lists from X (the page loaded but the list data didn't arrive). Retry once; if it fails again, report it.";

export interface XList {
  id: string;
  name: string;
  description: string;
  memberCount: number | null;
  private: boolean;
  ownerHandle: string | null;
  url: string;
}

/** Pull the numeric list ID out of a list URL, or accept a bare ID. */
export function parseListId(input: string): string | null {
  const m = input.match(/\/i\/lists\/(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

/** Logged-in user's handle, read from the side-nav Profile link. */
export async function getMyHandle(page: Page): Promise<string | null> {
  const href = await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href').catch(() => null);
  return href ? href.replace(/^\//, '') : null;
}

/**
 * Walk any JSON value and collect objects that look like X list records
 * (id_str + name + mode). Endpoint-name-agnostic on purpose: X renames
 * GraphQL operations, but the list object shape has been stable.
 */
function collectListObjects(node: unknown, out: Map<string, XList>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) collectListObjects(v, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.id_str === 'string' && typeof o.name === 'string' && typeof o.mode === 'string') {
    const owner = (o.user_results as { result?: Record<string, any> } | undefined)?.result;
    const ownerHandle: string | null = owner?.core?.screen_name ?? owner?.legacy?.screen_name ?? null;
    out.set(o.id_str, {
      id: o.id_str,
      name: o.name,
      description: typeof o.description === 'string' ? o.description : '',
      memberCount: typeof o.member_count === 'number' ? o.member_count : null,
      private: o.mode.toLowerCase() === 'private',
      ownerHandle,
      url: X_URLS.list(o.id_str),
    });
  }
  for (const v of Object.values(o)) collectListObjects(v, out);
}

/**
 * The logged-in user's own lists. Loads their /lists page and reads the
 * GraphQL responses the page itself fetches — the list rows in the DOM
 * carry no links, so the IDs are only available from the data.
 */
/** Returns null when the lists can't be read (no handle, or the data never arrived). */
export async function fetchMyLists(page: Page): Promise<{ handle: string; lists: XList[] } | null> {
  const handle = await getMyHandle(page);
  if (!handle) return null;
  const found = new Map<string, XList>();
  const pending: Promise<void>[] = [];
  const onResponse = (res: import('playwright-core').Response) => {
    if (!res.url().includes('/graphql/')) return;
    pending.push(res.json().then((j) => collectListObjects(j, found)).catch(() => {}));
  };
  page.on('response', onResponse);
  try {
    // Wait for the lists query itself rather than a fixed delay — on a slow
    // night it landed after the old 5s window and the tool reported
    // "0 lists" (2026-09-23). Armed before goto so a fast response isn't missed.
    const listsQuery = page
      .waitForResponse((r) => /\/graphql\/[^/]+\/ListsManagement/.test(r.url()), { timeout: 30000 })
      .catch(() => null);
    await page.goto(X_URLS.userLists(handle), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await listsQuery;
    await page.waitForTimeout(1000);
    await Promise.all(pending);
  } finally {
    page.off('response', onResponse);
  }
  const mine = [...found.values()].filter((l) => l.ownerHandle?.toLowerCase() === handle.toLowerCase());
  if (mine.length === 0) {
    // "You have no lists" makes an agent create duplicates, so only say it
    // when the page agrees. Rows on screen but no data = a failed read.
    const rows = await page.locator(X_SELECTORS.listCell).count().catch(() => 0);
    if (rows > 0) return null;
  }
  return { handle, lists: mine };
}

/**
 * Open a list's Edit List dialog. Going straight to /i/lists/<id>/info
 * redirects to the list page (verified 2026-09-23), so load the list and
 * click its "Edit List" link — only present on lists the user owns.
 */
export async function openEditListDialog(page: Page, id: string): Promise<boolean> {
  await page.goto(X_URLS.list(id), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
  const edit = page.locator(X_SELECTORS.listEditLink(id));
  const found = await edit.waitFor({ timeout: config.timeouts.navigation }).then(() => true).catch(() => false);
  if (!found) return false;
  await edit.click();
  return page.locator(X_SELECTORS.listNameInput).waitFor({ timeout: config.timeouts.navigation }).then(() => true).catch(() => false);
}

/**
 * Resolve a list reference (URL, ID, or exact name) to its ID and name,
 * among the user's own lists — the only ones whose membership they can
 * edit. Uses the same GraphQL read as fetchMyLists, no dialog needed.
 */
export async function resolveList(page: Page, ref: string): Promise<{ id: string; name: string } | { error: string }> {
  const mine = await fetchMyLists(page);
  if (!mine) return { error: LISTS_READ_FAILED };
  const id = parseListId(ref);
  const matches = id
    ? mine.lists.filter((l) => l.id === id)
    : mine.lists.filter((l) => l.name.toLowerCase() === ref.trim().toLowerCase());
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  if (matches.length > 1) return { error: `More than one of your lists is named "${ref}" — pass the list URL instead.` };
  const yours = mine.lists.map((l) => `"${l.name}" ${l.url}`).join(', ') || '(none)';
  return { error: `"${ref}" is not one of your lists. Your lists: ${yours}.` };
}

/**
 * Resolve a list reference to an ID. URLs/IDs pass straight through; a
 * name is looked up among the user's own lists (exact, case-insensitive).
 */
export async function resolveListId(page: Page, ref: string): Promise<{ id: string } | { error: string }> {
  const id = parseListId(ref);
  if (id) return { id };
  const mine = await fetchMyLists(page);
  if (!mine) return { error: LISTS_READ_FAILED };
  const matches = mine.lists.filter((l) => l.name.toLowerCase() === ref.trim().toLowerCase());
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) {
    return { error: `No list of yours is named "${ref}". Your lists: ${mine.lists.map((l) => `"${l.name}"`).join(', ') || '(none)'}.` };
  }
  return { error: `More than one of your lists is named "${ref}" — pass the list URL instead.` };
}

export function renderLists(lists: XList[], header: string): string {
  if (lists.length === 0) return `${header}\n(none)`;
  const rows = lists.map((l, i) => {
    const bits = [l.private ? 'private' : 'public'];
    if (l.memberCount !== null) bits.push(`${l.memberCount} member${l.memberCount === 1 ? '' : 's'}`);
    const desc = l.description ? ` — ${l.description}` : '';
    return `${i + 1}. ${l.name} (${bits.join(', ')})${desc}\n   ${l.url}`;
  });
  return `${header}\n${rows.join('\n')}`;
}
