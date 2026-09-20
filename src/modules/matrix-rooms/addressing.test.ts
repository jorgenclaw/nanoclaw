import { describe, expect, it } from 'vitest';

import { addressNames, caselessWord, orchestratorEngagePattern, subAgentEngagePattern } from './addressing.js';

// The router does exactly this: new RegExp(pattern).test(text), no flags.
const matches = (pattern: string, text: string): boolean => new RegExp(pattern).test(text);

describe('caselessWord', () => {
  it('matches a word in any letter case', () => {
    const re = new RegExp(`^${caselessWord('jorgenclaw')}$`);
    for (const w of ['jorgenclaw', 'Jorgenclaw', 'JORGENCLAW', 'jOrGeNcLaW']) expect(re.test(w)).toBe(true);
    expect(re.test('jorgenclaws')).toBe(false);
  });

  it('escapes regex metacharacters and keeps digits and dashes literal', () => {
    const re = new RegExp(`^${caselessWord('a.b-c1')}$`);
    expect(re.test('A.B-C1')).toBe(true);
    expect(re.test('aXb-c1')).toBe(false); // the dot is a literal dot
  });
});

describe('addressNames', () => {
  it('uses the first word of the agent name and the Matrix localpart, lowercased and de-duplicated', () => {
    expect(addressNames('Jorgenclaw', 'jorgenclaw')).toEqual(['jorgenclaw']);
    expect(addressNames('Jorgenclaw (Claude)', 'jorgenclaw')).toEqual(['jorgenclaw']);
    expect(addressNames('Quad', 'jorgenclaw')).toEqual(['quad', 'jorgenclaw']);
  });

  it('drops words that are not safe to put in a pattern', () => {
    expect(addressNames('J', 'jorgenclaw')).toEqual(['jorgenclaw']); // too short
    expect(addressNames('(x)', 'a b')).toEqual([]);
    expect(addressNames('', '')).toEqual([]);
  });
});

describe('orchestrator vs sub-agent engage patterns', () => {
  const names = ['jorgenclaw'];
  const orchestrator = orchestratorEngagePattern(names);
  const subAgent = subAgentEngagePattern(names);

  const addressedToOrchestrator = [
    'jorgenclaw, please check the plan',
    'Jorgenclaw please check the plan',
    '@jorgenclaw what did I ask coder?',
    '@Jorgenclaw: status?',
    '  jorgenclaw hello', // leading whitespace
    'JORGENCLAW',
    'jorgenclaw', // just the name (a bare mention pill)
    'Jorgenclaw\nsecond line',
  ];
  const addressedToSubAgent = [
    'please fix the login bug',
    'Coder, tell jorgenclaw the build is done', // names him, but does not START with him
    'hello jorgenclaw',
    'jorgenclaws website needs a footer', // a different word
    'what is 2+2',
    '', // empty text still goes to the room's own agent
    '@coder hi',
  ];

  it.each(addressedToOrchestrator)('"%s" goes to the orchestrator only', (text) => {
    expect(matches(orchestrator, text)).toBe(true);
    expect(matches(subAgent, text)).toBe(false);
  });

  it.each(addressedToSubAgent)('"%s" goes to the sub-agent only', (text) => {
    expect(matches(orchestrator, text)).toBe(false);
    expect(matches(subAgent, text)).toBe(true);
  });

  it('is an exact partition: never both, never neither', () => {
    for (const text of [...addressedToOrchestrator, ...addressedToSubAgent]) {
      expect(matches(orchestrator, text)).not.toBe(matches(subAgent, text));
    }
  });

  it('supports several names for the orchestrator', () => {
    const multi = ['jorgenclaw', 'quad'];
    expect(matches(orchestratorEngagePattern(multi), 'Quad, hi')).toBe(true);
    expect(matches(subAgentEngagePattern(multi), 'Quad, hi')).toBe(false);
    expect(matches(subAgentEngagePattern(multi), 'hi there')).toBe(true);
  });

  it('produces patterns the router can compile (a bad regex would fail open and answer everything)', () => {
    expect(() => new RegExp(orchestrator)).not.toThrow();
    expect(() => new RegExp(subAgent)).not.toThrow();
    expect(subAgent).not.toBe('.'); // '.' is the router's "always engage" shortcut
  });
});
