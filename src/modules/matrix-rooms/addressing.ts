/**
 * Who answers in a sub-agent's room.
 *
 * A room made for a sub-agent also holds its orchestrator (Jorgenclaw) as a quiet
 * member. Both are wired to the same room, and each agent is judged only against
 * its own wiring, so without a rule every message would be answered twice. The rule
 * is a clean split on how the message STARTS:
 *
 *   - it starts with the orchestrator's name ("jorgenclaw, ..." / "@jorgenclaw ...")
 *       -> the orchestrator answers, the sub-agent stays quiet;
 *   - anything else -> the sub-agent answers, the orchestrator only keeps it as background.
 *
 * Why the text and not a Matrix @-mention: Element X puts only the person's display
 * name in the message text and keeps the real mention in metadata, so a mention
 * cannot be told apart from the text alone. A leading name always can.
 *
 * The router tests engage patterns with `new RegExp(pattern)` and no flags, and
 * JavaScript has no inline case-insensitive switch, so each letter becomes a class.
 */

/** A regex source that matches `word` in any letter case. */
export function caselessWord(word: string): string {
  return [...word]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      if (lower !== upper) return `[${upper}${lower}]`;
      return ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    })
    .join('');
}

const NAME_WORD = /^[A-Za-z0-9_-]{2,40}$/;

/**
 * The words that address the orchestrator: the first word of its agent name and
 * its Matrix localpart (they are usually the same). Anything odd is dropped, and
 * an empty result means "no safe way to address it".
 */
export function addressNames(agentName: string, matrixLocalpart: string): string[] {
  const words = [agentName.trim().split(/\s+/)[0] ?? '', matrixLocalpart]
    .filter((w) => NAME_WORD.test(w))
    .map((w) => w.toLowerCase());
  return [...new Set(words)];
}

function leadingName(names: string[]): string {
  return `\\s*@?(?:${names.map(caselessWord).join('|')})\\b`;
}

/** Engage pattern for the orchestrator: only messages that start with its name. */
export function orchestratorEngagePattern(names: string[]): string {
  return `^${leadingName(names)}`;
}

/** Engage pattern for the sub-agent: everything EXCEPT messages that start with the orchestrator's name. */
export function subAgentEngagePattern(names: string[]): string {
  return `^(?!${leadingName(names)})`;
}
