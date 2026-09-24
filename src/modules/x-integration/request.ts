/**
 * Validation + hold-request builders for the four guard-gated X actions
 * (delete tweet, unfollow, retweet, unretweet — see ./guard.ts).
 *
 * Precheck runs before any hold is created — a malformed request is
 * answered directly (notifyAgent) and never becomes a card. The hold
 * builders card the owner with exactly the fields the guard will bind the
 * approval to (see grantCoversRequest in ./guard.ts), so the payload here
 * must match those field names.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

function missing(content: Record<string, unknown>, key: string): boolean {
  return content[key] === undefined || content[key] === null || content[key] === '';
}

/**
 * Card the owner — unless this exact request is already waiting. An agent
 * that retries while a card is open would otherwise send a fresh card per
 * retry (four identical delete-tweet cards on 2026-09-22). Resolved
 * approvals are deleted, so any matching row is still open. Matched by
 * session: requestApproval doesn't fill pending_approvals.agent_group_id.
 */
async function holdOnce(
  session: Session,
  action: string,
  payload: Record<string, unknown>,
  title: string,
  question: (agentName: string) => string,
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const wanted = JSON.stringify(payload);
  const findOpen = () =>
    getPendingApprovalsByAction(action).find((row) => row.session_id === session.id && row.payload === wanted);
  const open = findOpen();
  if (open) {
    notifyAgent(
      session,
      `${action}: this exact request is already waiting for the owner's approval (${open.approval_id}). ` +
        `Don't send it again — the result will arrive once they answer.`,
    );
    return;
  }
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action,
    payload,
    title,
    question: question(agentGroup.name),
  });
  // requestApproval reports its own failures to the agent; only confirm
  // when the card actually exists.
  if (findOpen()) {
    notifyAgent(
      session,
      `${action}: sent to the owner for approval. The result will arrive once they answer — don't resend.`,
    );
  }
}

// ── x_delete_tweet ──────────────────────────────────────────

export function validateXDeleteTweet(content: Record<string, unknown>, session: Session): boolean {
  if (missing(content, 'tweetUrl') || missing(content, 'textMustMatch')) {
    notifyAgent(session, 'x_delete_tweet failed: missing tweetUrl or textMustMatch.');
    return false;
  }
  return true;
}

export async function requestXDeleteTweetHold(content: Record<string, unknown>, session: Session): Promise<void> {
  await holdOnce(
    session,
    'x_delete_tweet',
    { tweetUrl: content.tweetUrl, textMustMatch: content.textMustMatch },
    'Delete tweet',
    (agentName) =>
      `Agent "${agentName}" wants to permanently delete the tweet at ${content.tweetUrl} (text must match: "${content.textMustMatch}"). This cannot be undone. Approve?`,
  );
}

// ── x_unfollow ──────────────────────────────────────────────

export function validateXUnfollow(content: Record<string, unknown>, session: Session): boolean {
  if (missing(content, 'handle')) {
    notifyAgent(session, 'x_unfollow failed: missing handle.');
    return false;
  }
  return true;
}

export async function requestXUnfollowHold(content: Record<string, unknown>, session: Session): Promise<void> {
  await holdOnce(
    session,
    'x_unfollow',
    { handle: content.handle },
    'Unfollow on X',
    (agentName) => `Agent "${agentName}" wants to unfollow @${content.handle} on X. Approve?`,
  );
}

// ── x_retweet ───────────────────────────────────────────────

export function validateXRetweet(content: Record<string, unknown>, session: Session): boolean {
  if (missing(content, 'tweetUrl')) {
    notifyAgent(session, 'x_retweet failed: missing tweetUrl.');
    return false;
  }
  return true;
}

export async function requestXRetweetHold(content: Record<string, unknown>, session: Session): Promise<void> {
  await holdOnce(
    session,
    'x_retweet',
    { tweetUrl: content.tweetUrl },
    'Retweet',
    (agentName) => `Agent "${agentName}" wants to retweet ${content.tweetUrl} on the user's account. Approve?`,
  );
}

// ── x_unretweet ─────────────────────────────────────────────

export function validateXUnretweet(content: Record<string, unknown>, session: Session): boolean {
  if (missing(content, 'tweetUrl')) {
    notifyAgent(session, 'x_unretweet failed: missing tweetUrl.');
    return false;
  }
  return true;
}

export async function requestXUnretweetHold(content: Record<string, unknown>, session: Session): Promise<void> {
  await holdOnce(
    session,
    'x_unretweet',
    { tweetUrl: content.tweetUrl },
    'Undo retweet',
    (agentName) => `Agent "${agentName}" wants to undo the retweet of ${content.tweetUrl}. Approve?`,
  );
}
