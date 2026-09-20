/**
 * Matrix-rooms module — lets an agent ask for a Matrix room of its own.
 *
 * Registers its guard-catalog entry (./guard.js) and one guard-wrapped
 * delivery action, `create_matrix_room`. The guard holds EVERY request for
 * owner approval; the approval handler re-enters the wrapped action carrying
 * the approval row as its grant, and `createMatrixRoom` then asks the
 * agent's own Matrix adapter instance to make the room and wires it up.
 *
 * Host integration points:
 *   - the Matrix channel (src/channels/matrix.ts) must be installed and
 *     connected: it exposes `createMatrixRoom` on its bridge. Without it the
 *     action answers the requester with "not connected" and does nothing.
 *   - container side: container/agent-runner/src/mcp-tools/matrix-rooms.ts
 *     (the tool) and matrix-rooms.instructions.md (how to use it).
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { createMatrixRoom, requestCreateMatrixRoomHold, validateCreateMatrixRoom } from './create-room.js';
import { matrixRoomsCreate } from './guard.js';

registerDeliveryAction('create_matrix_room', createMatrixRoom, {
  guardAction: matrixRoomsCreate,
  precheck: validateCreateMatrixRoom,
  requestHold: requestCreateMatrixRoomHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_matrix_room denied: ${reason}`),
});
registerApprovalHandler('create_matrix_room', reenterGuardedDeliveryAction('create_matrix_room'));
