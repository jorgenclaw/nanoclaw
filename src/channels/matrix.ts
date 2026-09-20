/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports two auth methods (resolved by the adapter from env):
 *   - Access token: MATRIX_ACCESS_TOKEN + MATRIX_USER_ID
 *   - Password:     MATRIX_USERNAME + MATRIX_PASSWORD (+ optional MATRIX_USER_ID)
 *
 * Optional env vars:
 *   MATRIX_BOT_USERNAME         — display name for the bot (default: "bot")
 *   MATRIX_INVITE_AUTOJOIN      — "true" to auto-accept room invites
 *   MATRIX_INVITE_AUTOJOIN_ALLOWLIST — comma-separated user IDs allowed to invite
 *   MATRIX_RECOVERY_KEY         — enable E2EE cross-signing
 *   MATRIX_DEVICE_ID            — stable device ID across restarts
 *
 * Sub-agents speak as their own accounts: each entry in data/matrix-agent-accounts.json
 * (written by scripts/matrix-provision-agent.ts) becomes a named instance `matrix-<folder>`.
 */
import path from 'path';

import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

import { DATA_DIR } from '../config.js';
import { getAskQuestionRender } from '../db/sessions.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  ACCOUNTS_FILE_NAME,
  loadAgentAccounts,
  matrixInstanceName,
  matrixLocalpart,
  type AgentAccount,
} from './matrix-agent-accounts.js';
import { cardToAnswerableText, findPendingCard, matchAnswer, QUESTION_KEY } from './matrix-cards.js';

/**
 * Assumes a dedicated bot account on a homeserver (the common install).
 * Non-threaded at the bridge level, so group engagement is 'mention', never
 * sticky. Personal-account installs should edit their copy to dm 'strict' —
 * install-wide changes live in this declaration by design.
 */
const MATRIX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_DEVICE_ID',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
] as const;

/**
 * Custom Matrix state event stamped on every room NanoClaw creates for an
 * agent (see createMatrixRoom). The marker lives in Matrix itself, so it
 * survives a database loss and a future model can read it off the room.
 */
export const AGENT_ROOM_STATE_TYPE = 'ai.jorgenclaw.agent_room';

/** Room-creation capability the bridge exposes to the host (src/modules/matrix-rooms). */
export interface MatrixRoomCapable {
  createMatrixRoom(opts: {
    name: string;
    topic?: string;
    invite: string[];
    agentGroupId: string;
  }): Promise<{ roomId: string; platformId: string }>;
}

/**
 * Wrap the Matrix adapter so DM conversations are identified by user handle
 * across the whole system, not by ephemeral room IDs.
 *
 * Matrix DMs live in rooms (e.g. "!abc:server"), but NanoClaw identifies
 * channels by platform_id. Using a user handle as platform_id means both
 * the user and the messaging group reference the same stable identifier.
 *
 * Two directions to bridge:
 *   - Outbound: delivery passes "matrix:@user:server" → resolve to room via openDM
 *   - Inbound: adapter emits "matrix:!room:server" → rewrite to user handle
 *     so the router finds the existing messaging group instead of creating
 *     a new one.
 *
 * Both resolutions are cached for the process lifetime.
 *
 * "Agent rooms" (created by createMatrixRoom, marked with AGENT_ROOM_STATE_TYPE)
 * are the exception: each belongs to one agent and is addressed by its room id.
 * They are excluded from every DM rule here, so a room holding just the user
 * and the bot is never mistaken for the user's DM.
 */
function wrapWithDmResolution(adapter: ReturnType<typeof createMatrixAdapter>): typeof adapter & {
  warmDmCaches: () => Promise<void>;
  isAgentRoom: (roomID: string) => boolean;
} & MatrixRoomCapable {
  const origPostMessage = adapter.postMessage.bind(adapter);
  const origStartTyping = adapter.startTyping.bind(adapter);
  const origChannelIdFromThreadId = adapter.channelIdFromThreadId.bind(adapter);
  const origOpenDM = adapter.openDM.bind(adapter);

  // roomId → user handle, used to rewrite inbound channel IDs.
  const roomToUserCache = new Map<string, string>();
  // user handle → the 1:1 room they were last seen in, so replies follow them.
  const userToRoomCache = new Map<string, string>();
  // user handle → last room logged for it, so the typing loop doesn't spam.
  const lastLoggedRoom = new Map<string, string>();

  // Rooms NanoClaw made for an agent. Read off the room's marker state event
  // (non-member state is fully loaded at sync, unlike the member list), and
  // remembered so the check stays cheap.
  const agentRooms = new Set<string>();
  function isAgentRoom(roomID: string): boolean {
    if (agentRooms.has(roomID)) return true;
    const room = (adapter as any).client?.getRoom(roomID);
    const marked = !!room?.currentState?.getStateEvents(AGENT_ROOM_STATE_TYPE, '');
    if (marked) agentRooms.add(roomID);
    return marked;
  }

  const WARM_TTL_MS = 30_000;
  let warming: Promise<void> | null = null;
  let lastWarmAt = 0;

  async function mostRecentlyActive(roomIDs: string[]): Promise<string> {
    const client = (adapter as any).client;
    let best = roomIDs[0];
    let bestTs = -1;
    for (const roomID of roomIDs) {
      const res = await client.createMessagesRequest(roomID, null, 5, 'b').catch(() => null);
      const ts = res?.chunk?.find((e: any) => e.type === 'm.room.message')?.origin_server_ts ?? 0;
      if (ts > bestTs) {
        best = roomID;
        bestTs = ts;
      }
    }
    return best;
  }

  /**
   * Map DM rooms from the homeserver rather than the client's member state,
   * which stays empty for a while after startup (joined 0, user null). Without
   * this the first DM after a restart isn't recognised as the user's DM: it
   * gets a room-based messaging group (→ registration card) and outbound finds
   * no live room and creates a brand-new one. Encrypted rooms are skipped —
   * the bot has no keys. Throttled; concurrent callers share one run.
   */
  function warmDmCaches(): Promise<void> {
    if (warming) return warming;
    if (Date.now() - lastWarmAt < WARM_TTL_MS) return Promise.resolve();

    warming = (async () => {
      const client = (adapter as any).client;
      const botId = (adapter as any).userID;
      if (!client || !botId) return;

      // A 404 means "no such state event"; anything else is a real failure.
      const hasState = (roomID: string, type: string): Promise<boolean> =>
        client.getStateEvent(roomID, type, '').then(
          () => true,
          (err: { httpStatus?: number; errcode?: string }) => {
            if (err?.httpStatus === 404 || err?.errcode === 'M_NOT_FOUND') return false;
            throw err;
          },
        );

      const { joined_rooms } = await client.getJoinedRooms();
      const byUser = new Map<string, string[]>();
      for (const roomID of joined_rooms as string[]) {
        const { joined } = await client.getJoinedRoomMembers(roomID);
        const others = Object.keys(joined).filter((id) => id !== botId);
        if (others.length !== 1) continue;

        // Agent rooms are addressed by room id, never through the DM caches.
        if (agentRooms.has(roomID) || (await hasState(roomID, AGENT_ROOM_STATE_TYPE))) {
          agentRooms.add(roomID);
          continue;
        }
        if (await hasState(roomID, 'm.room.encryption')) continue;
        byUser.set(others[0], [...(byUser.get(others[0]) ?? []), roomID]);
      }

      userToRoomCache.clear();
      for (const [user, rooms] of byUser) {
        for (const roomID of rooms) roomToUserCache.set(roomID, user);
        userToRoomCache.set(user, rooms.length === 1 ? rooms[0] : await mostRecentlyActive(rooms));
      }
      log.info('Matrix: DM rooms mapped from homeserver', {
        users: byUser.size,
        rooms: [...byUser.values()].flat().length,
      });
    })()
      .catch((err) => log.warn('Matrix: DM room warm-up failed', { err }))
      .finally(() => {
        lastWarmAt = Date.now();
        warming = null;
      });
    return warming;
  }

  /**
   * A 1:1 room the user has actually joined with the bot, or null.
   *
   * The adapter's own openDM only trusts the bot's m.direct and the bot's own
   * membership, so it returns rooms the user was merely invited to and never
   * sees DMs the user started from their own client (Element X records those
   * in the user's account data, not the bot's). Prefer the room the user last
   * wrote from, then whichever joined 1:1 room is most recently active.
   */
  function liveDmRoomFor(userHandle: string): string | null {
    const client = (adapter as any).client;
    if (!client) return null;

    // The bot's own membership is deliberately not checked: this client reports
    // getMyMembership() === 'leave' (the unset default) and a joined count of 1
    // for a DM the server says the bot is in, so both are unreliable here. The
    // user's membership is reliable, and receiving their events is itself proof
    // the bot is still in the room. Same "not a group" threshold as isDM above.
    // Encrypted rooms are skipped — the bot has no keys, so it can't read them.
    const isLive = (roomID: string): boolean => {
      const room = client.getRoom(roomID);
      if (!room) return false;
      if (isAgentRoom(roomID)) return false;
      if (room.getJoinedMemberCount() > 2) return false;
      if (room.hasEncryptionStateEvent?.()) return false;
      return room.getJoinedMembers().some((m: { userId: string }) => m.userId === userHandle);
    };

    // A remembered room came from the homeserver or from a live inbound, so
    // only drop it once the client has positively seen it change (user left,
    // room grew, turned encrypted) — not merely because member state is unloaded.
    const contradicted = (roomID: string): boolean => {
      const room = client.getRoom(roomID);
      if (!room) return false;
      if (isAgentRoom(roomID)) return true;
      if (room.getJoinedMemberCount() > 2 || room.hasEncryptionStateEvent?.()) return true;
      const membership = room.getMember?.(userHandle)?.membership;
      return !!membership && membership !== 'join';
    };

    const remembered = userToRoomCache.get(userHandle);
    if (remembered && !contradicted(remembered)) return remembered;

    let best: { roomID: string; ts: number } | null = null;
    for (const room of client.getRooms()) {
      if (!isLive(room.roomId)) continue;
      const ts = room.getLastActiveTimestamp?.() ?? 0;
      if (!best || ts > best.ts) best = { roomID: room.roomId, ts };
    }
    if (best) return best.roomID;

    // Nothing usable — record why, once per distinct state, so a fallback to
    // the adapter's own openDM is explainable from the log.
    const rooms = client.getRooms().map((room: any) => ({
      roomID: room.roomId,
      mine: room.getMyMembership(),
      joined: room.getJoinedMemberCount(),
      user: room.getMember?.(userHandle)?.membership ?? null,
      encrypted: !!room.hasEncryptionStateEvent?.(),
    }));
    const key = JSON.stringify(rooms);
    if (lastLoggedRoom.get(`fallback:${userHandle}`) !== key) {
      lastLoggedRoom.set(`fallback:${userHandle}`, key);
      log.warn('Matrix: no live DM room, falling back to adapter.openDM', { userHandle, remembered, rooms });
    }
    return null;
  }

  // Cold DMs (approvals, scheduled sends) resolve here via the bridge too.
  adapter.openDM = async (userId: string): Promise<string> => {
    let live = liveDmRoomFor(userId);
    if (!live) {
      // Ask the homeserver before the adapter is allowed to create a room.
      await warmDmCaches();
      live = liveDmRoomFor(userId);
    }
    return live ? adapter.encodeThreadId({ roomID: live }) : origOpenDM(userId);
  };

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
      if (lastLoggedRoom.get(userHandle) !== roomID) {
        lastLoggedRoom.set(userHandle, roomID);
        log.info('Matrix: resolved DM room for user handle', { userHandle, roomID });
      }
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);
      // Agent rooms keep their own room-based address (never collapsed to a DM).
      if (isAgentRoom(roomID)) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) {
        userToRoomCache.set(cached, roomID);
        return `matrix:${cached}`;
      }

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;
      const otherMember = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId);
      if (!otherMember) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherMember.userId);
      userToRoomCache.set(otherMember.userId, roomID);
      return `matrix:${otherMember.userId}`;
    } catch {
      return origChannelIdFromThreadId(threadId);
    }
  };

  // The Chat SDK calls adapter.isDM(threadId) synchronously to decide whether
  // to dispatch to onDirectMessage handlers. The Matrix adapter doesn't expose
  // this method — it only has an async isDirectRoom(). We add a synchronous
  // isDM that checks room membership count: 2 members = DM.
  (adapter as any).isDM = (threadId: string): boolean => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      const client = (adapter as any).client;
      if (!client) return false;
      const room = client.getRoom(roomID);
      if (!room) return false;
      const members = room.getJoinedMemberCount();
      return members <= 2;
    } catch {
      return false;
    }
  };

  adapter.postMessage = async (
    threadId: string,
    ...args: Parameters<typeof origPostMessage> extends [string, ...infer R] ? R : never
  ) => {
    const resolvedTid = await resolveThreadId(threadId);

    // Element X cannot render card buttons (the adapter flattens a card to
    // plain text), so a question card would be unanswerable. Send it as a
    // numbered list the user answers by replying, with the question id stamped
    // on the event (see matrix-cards.ts and tryAnswerCard in the factory).
    const card = cardToAnswerableText(args[0]);
    const client = (adapter as any).client;
    if (card && client) {
      const { roomID } = adapter.decodeThreadId(resolvedTid);
      const res = await client.sendMessage(roomID, {
        msgtype: 'm.text',
        body: card.text,
        [QUESTION_KEY]: { id: card.questionId, v: 1 },
      });
      return { id: res.event_id, threadId: resolvedTid, raw: res } as Awaited<ReturnType<typeof origPostMessage>>;
    }

    return origPostMessage(resolvedTid, ...args);
  };

  adapter.startTyping = async (threadId: string) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origStartTyping(resolvedTid);
  };

  /**
   * Create a private, unencrypted room for an agent and invite people to it.
   * The room is marked (AGENT_ROOM_STATE_TYPE) BEFORE its address is computed,
   * so it gets the raw room-based platform id, not a DM handle. Wiring the room
   * to an agent is the caller's job (src/modules/matrix-rooms).
   */
  async function createMatrixRoom(opts: {
    name: string;
    topic?: string;
    invite: string[];
    agentGroupId: string;
  }): Promise<{ roomId: string; platformId: string }> {
    const client = (adapter as any).client;
    if (!client) throw new Error('Matrix client is not ready');

    const res = await client.createRoom({
      name: opts.name,
      topic: opts.topic,
      visibility: 'private',
      // Invited people get the creator's power level, so the owner can manage
      // a room an agent made. No m.room.encryption: the bot cannot read
      // encrypted rooms.
      preset: 'trusted_private_chat',
      invite: opts.invite,
      initial_state: [
        { type: AGENT_ROOM_STATE_TYPE, state_key: '', content: { agent_group_id: opts.agentGroupId, v: 1 } },
      ],
    });
    const roomId = res.room_id as string;
    agentRooms.add(roomId);
    const platformId = adapter.channelIdFromThreadId(adapter.encodeThreadId({ roomID: roomId }));
    log.info('Matrix: agent room created', { roomId, agentGroupId: opts.agentGroupId, invited: opts.invite.length });
    return { roomId, platformId };
  }

  return Object.assign(adapter, { warmDmCaches, isAgentRoom, createMatrixRoom });
}

/**
 * The channel factory for ONE Matrix account: the default account (@jorgenclaw)
 * and each per-agent account share everything below; only how the underlying
 * adapter is built, and the instance name, differ.
 */
function createMatrixFactory(buildAdapter: () => ReturnType<typeof wrapWithDmResolution> | null, instance?: string) {
  return () => {
    const matrixAdapter = buildAdapter();
    if (!matrixAdapter) return null;
    const bridge = createChatSdkBridge({
      adapter: matrixAdapter,
      ...(instance ? { instance } : {}),
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: MATRIX_DEFAULTS,
    });

    // Matrix user IDs contain ":" (e.g. "@user:matrix.org") which the shared
    // permissions module interprets as already-prefixed. Wrap onInbound to
    // ensure senderId always carries the "matrix:" channel prefix so user
    // records match between init-first-agent and inbound routing.
    const origSetup = bridge.setup.bind(bridge);
    bridge.setup = async (hostConfig) => {
      const origOnInbound = hostConfig.onInbound.bind(hostConfig);

      /**
       * Answer a pending question card by replying with its number (or label).
       * Only a SHORT reply that matches an option of the newest still-pending
       * card is consumed; everything else is ordinary chat. The host still
       * checks the sender is an authorized approver. senderId is passed with
       * its "matrix:" prefix: the approvals code treats an id containing ":"
       * as already namespaced, so a bare "@scott:server" would never match.
       */
      const tryAnswerCard = async (threadId: string | null, content: Record<string, unknown>): Promise<boolean> => {
        const text = typeof content.text === 'string' ? content.text : '';
        const senderId = typeof content.senderId === 'string' ? content.senderId : '';
        if (!threadId || !text || text.length > 40 || !senderId) return false;
        const client = (matrixAdapter as any).client;
        const botId = (matrixAdapter as any).userID;
        if (!client || !botId) return false;

        let here: string;
        try {
          here = matrixAdapter.decodeThreadId(threadId).roomID;
        } catch {
          return false;
        }
        const rooms = [client.getRoom(here), ...client.getRooms().filter((r: any) => r.roomId !== here)].filter(
          Boolean,
        );
        for (const room of rooms) {
          const events = [...room.getLiveTimeline().getEvents()].reverse();
          const questionId = findPendingCard(events, botId, (id) => !!getAskQuestionRender(id));
          if (!questionId) continue;
          const option = matchAnswer(text, getAskQuestionRender(questionId)!.options);
          if (!option) return false; // a card is open, but this is just chat
          log.info('Matrix: question answered by text reply', { questionId, answer: option.label, senderId });
          hostConfig.onAction(questionId, option.value, senderId);
          matrixAdapter
            .postMessage(threadId, `Answer sent: ${option.label}`)
            .catch((err: unknown) => log.warn('Matrix: could not confirm card answer', { err }));
          return true;
        }
        return false;
      };

      await origSetup({
        ...hostConfig,
        onInbound: async (platformId, threadId, message) => {
          if (message.content && typeof message.content === 'object') {
            const content = message.content as Record<string, unknown>;
            if (typeof content.senderId === 'string' && !content.senderId.startsWith('matrix:')) {
              content.senderId = `matrix:${content.senderId}`;
            }
            if (await tryAnswerCard(threadId, content)) return; // consumed as an answer, not chat
          }
          // A room-based id here can mean the DM caches were still cold (right
          // after startup). Map from the homeserver and re-derive, so the DM
          // isn't routed to a new unwired messaging group. Real group rooms
          // come back unchanged; the warm-up is throttled.
          if (threadId && platformId.startsWith('matrix:!')) {
            let agentRoom = false;
            try {
              agentRoom = matrixAdapter.isAgentRoom(matrixAdapter.decodeThreadId(threadId).roomID);
            } catch {
              // not a room-shaped thread id; treat as an ordinary room
            }
            if (!agentRoom) {
              await matrixAdapter.warmDmCaches();
              platformId = matrixAdapter.channelIdFromThreadId(threadId);
            }
          }
          return origOnInbound(platformId, threadId, message);
        },
      });

      // Wait for Matrix sync to reach PREPARED state before returning from setup.
      // Without this, the host's delivery poll and sweep timer start immediately
      // and can starve the SDK's sync generator microtask queue, blocking
      // incremental syncs so new inbound messages never get dispatched.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
            log.info('Matrix sync ready');
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 30_000);
      });

      await matrixAdapter.warmDmCaches();
    };

    // The registry hands the host this bridge, not the raw adapter, so the
    // room-creation capability has to ride on it.
    return Object.assign(bridge, { createMatrixRoom: matrixAdapter.createMatrixRoom });
  };
}

registerChannelAdapter('matrix', {
  factory: createMatrixFactory(() => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.MATRIX_BASE_URL) return null;
    if (!env.MATRIX_ACCESS_TOKEN && !(env.MATRIX_USERNAME && env.MATRIX_PASSWORD)) return null;

    for (const key of ENV_KEYS) {
      if (env[key]) process.env[key] = env[key];
    }

    // Default: auto-join room invites so DMs work without manual acceptance
    if (!process.env.MATRIX_INVITE_AUTOJOIN) {
      process.env.MATRIX_INVITE_AUTOJOIN = 'true';
    }

    return wrapWithDmResolution(createMatrixAdapter());
  }),
  defaults: MATRIX_DEFAULTS,
});

/**
 * A sub-agent's own account. Configured explicitly instead of through
 * process.env (which the default account owns), and with NO invite auto-join:
 * the agent only ever lives in rooms NanoClaw created for it, so nobody can pull
 * it into a room by inviting it.
 */
function createAgentAccountAdapter(account: AgentAccount) {
  const baseURL = readEnvFile(['MATRIX_BASE_URL']).MATRIX_BASE_URL;
  if (!baseURL) return null;
  return wrapWithDmResolution(
    createMatrixAdapter({
      baseURL,
      auth: { type: 'accessToken', accessToken: account.accessToken, userID: account.userId },
      userName: matrixLocalpart(account.userId),
      deviceID: account.deviceId,
      matrixSDKLogLevel: 'error',
    }),
  );
}

/**
 * Register one named instance per agent that has its own account, and return
 * the instance names. Read once at load (like the registry itself), so a new
 * account takes effect at the next restart.
 */
export function registerAgentAccountInstances(accountsFile: string): string[] {
  const { accounts, problems } = loadAgentAccounts(accountsFile);
  for (const problem of problems) log.warn(`Matrix agent accounts: ${problem}`);
  return accounts.map((account) => {
    const instance = matrixInstanceName(account.folder);
    registerChannelAdapter(instance, {
      factory: createMatrixFactory(() => createAgentAccountAdapter(account), instance),
      defaults: MATRIX_DEFAULTS,
    });
    return instance;
  });
}

registerAgentAccountInstances(path.join(DATA_DIR, ACCOUNTS_FILE_NAME));
