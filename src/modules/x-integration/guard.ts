/**
 * X-integration guard adapter — the module's catalog entries, composed at
 * the module edge (imported by ./index.ts).
 *
 * Four destructive X actions always hold for owner approval when the
 * requester is an agent: deleting a tweet, unfollowing someone, retweeting,
 * and un-retweeting. These publish or change state on the user's real X
 * account with no undo path a script can drive (retweet/unfollow are
 * reversible by hand, but not by the agent without asking again), so — same
 * posture as self-mod and matrix-rooms — there is no "trusted" fast path.
 * Everything else in the skill (reads, posting, replying, liking,
 * bookmarking, following, DMs) stays unguarded, matching the skill's
 * existing per-action trust model.
 *
 * Each grant is bound to the exact request that was approved (tweet URL /
 * handle, plus the text-echo guard for delete) so an approval can never be
 * replayed against a different target.
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';

function sameField(grant: PendingApproval, input: GuardInput, key: string): boolean {
  try {
    const approved = JSON.parse(grant.payload) as Record<string, unknown>;
    return JSON.stringify(approved[key] ?? null) === JSON.stringify(input.payload[key] ?? null);
  } catch {
    return false;
  }
}

function xDecide(label: string) {
  return (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY(`${label} is a container-originated action.`);
    }
    return HOLD(`${label} is a destructive X action and always requires owner approval`);
  };
}

/** Irreversibly removes one of the user's own tweets. */
export const xDeleteTweet = defineGuardedAction({
  action: 'x.delete_tweet',
  grantActionName: 'x_delete_tweet',
  grantCoversRequest: (grant, input) => sameField(grant, input, 'tweetUrl') && sameField(grant, input, 'textMustMatch'),
  decide: xDecide('x_delete_tweet'),
});

/** Changes the follow graph on the user's real account. */
export const xUnfollow = defineGuardedAction({
  action: 'x.unfollow',
  grantActionName: 'x_unfollow',
  grantCoversRequest: (grant, input) => sameField(grant, input, 'handle'),
  decide: xDecide('x_unfollow'),
});

/** Publishes content on someone else's thread under the user's account. */
export const xRetweet = defineGuardedAction({
  action: 'x.retweet',
  grantActionName: 'x_retweet',
  grantCoversRequest: (grant, input) => sameField(grant, input, 'tweetUrl'),
  decide: xDecide('x_retweet'),
});

/** Revokes a retweet — not visible to the original author but still a
 *  network-change operation. */
export const xUnretweet = defineGuardedAction({
  action: 'x.unretweet',
  grantActionName: 'x_unretweet',
  grantCoversRequest: (grant, input) => sameField(grant, input, 'tweetUrl'),
  decide: xDecide('x_unretweet'),
});
