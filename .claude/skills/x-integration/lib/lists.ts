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
    await page.goto(X_URLS.userLists(handle), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad + 2000);
    await Promise.all(pending);
  } finally {
    page.off('response', onResponse);
  }
  const mine = [...found.values()].filter((l) => l.ownerHandle?.toLowerCase() === handle.toLowerCase());
  return { handle, lists: mine };
}

/**
 * Resolve a list reference (URL, ID, or exact name) to its ID and name.
 * For a URL/ID the name is read from the edit dialog, so it only works for
 * lists the user owns — which is the only kind that can be edited anyway.
 */
export async function resolveList(page: Page, ref: string): Promise<{ id: string | null; name: string } | { error: string }> {
  const id = parseListId(ref);
  if (!id) return { id: null, name: ref.trim() };
  await page.goto(X_URLS.listEdit(id), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(config.timeouts.pageLoad);
  const input = page.locator(X_SELECTORS.listNameInput);
  const visible = await input.waitFor({ timeout: config.timeouts.elementWait }).then(() => true).catch(() => false);
  if (!visible) return { error: `Couldn't open list ${id} for editing — it may not exist or may not be one of your lists.` };
  return { id, name: await input.inputValue() };
}

/**
 * Resolve a list reference to an ID. URLs/IDs pass straight through; a
 * name is looked up among the user's own lists (exact, case-insensitive).
 */
export async function resolveListId(page: Page, ref: string): Promise<{ id: string } | { error: string }> {
  const id = parseListId(ref);
  if (id) return { id };
  const mine = await fetchMyLists(page);
  if (!mine) return { error: 'Could not determine the logged-in handle.' };
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
