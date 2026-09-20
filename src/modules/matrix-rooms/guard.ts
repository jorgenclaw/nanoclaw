/**
 * Matrix-rooms guard adapter — the module's catalog entry, composed at the
 * module edge (imported by ./index.ts).
 *
 * matrix.rooms.create — Scott decided (2026-09-19) that EVERY room an agent
 * asks for needs owner approval, so the decision for an agent actor is an
 * unconditional hold. A room is a new place people are invited into and a
 * new channel an agent will read, and the requester is an LLM that can be
 * talked into things, so there is no "trusted" fast path. Anything that is
 * not an agent (a forged human/host actor) is denied outright: this action is
 * container-originated only.
 *
 * The approval grant is bound to exactly what was approved — name, topic,
 * invite list and target agent — so an approval for one room can never be
 * replayed to create a different one.
 */
import { DENY, HOLD, defineGuardedAction } from '../../guard/index.js';

export const matrixRoomsCreate = defineGuardedAction({
  action: 'matrix.rooms.create',
  grantActionName: 'create_matrix_room',
  grantCoversRequest: (grant, input) => {
    try {
      const approved = JSON.parse(grant.payload) as Record<string, unknown>;
      const same = (key: string) =>
        JSON.stringify(approved[key] ?? null) === JSON.stringify(input.payload[key] ?? null);
      return same('name') && same('topic') && same('invite') && same('agent');
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_matrix_room is a container-originated action.');
    return HOLD('every Matrix room an agent asks for requires owner approval');
  },
});
