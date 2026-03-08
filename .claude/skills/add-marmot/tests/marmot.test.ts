import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('marmot skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: marmot');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('nostr-tools');
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'marmot.ts');
    expect(fs.existsSync(addFile)).toBe(true);

    const content = fs.readFileSync(addFile, 'utf-8');
    expect(content).toContain('class MarmotChannel');
    expect(content).toContain('implements Channel');

    // Test file for the channel
    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'marmot.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('MarmotChannel'");
  });

  it('has all files declared in modifies', () => {
    const barrelFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    const configFile = path.join(skillDir, 'modify', 'src', 'config.ts');

    expect(fs.existsSync(barrelFile)).toBe(true);
    expect(fs.existsSync(configFile)).toBe(true);

    const barrelContent = fs.readFileSync(barrelFile, 'utf-8');
    expect(barrelContent).toContain("import './marmot.js'");

    const configContent = fs.readFileSync(configFile, 'utf-8');
    expect(configContent).toContain('MARMOT_NOSTR_PRIVATE_KEY');
    expect(configContent).toContain('MARMOT_NOSTR_RELAYS');
    expect(configContent).toContain('MARMOT_POLL_INTERVAL_MS');
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'src', 'config.ts.intent.md')),
    ).toBe(true);
  });

  it('modified channels/index.ts adds marmot import', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'index.ts'),
      'utf-8',
    );

    // Barrel file registers marmot via import side-effect
    expect(content).toContain("import './marmot.js'");
    // Preserves existing channel comments/imports
    expect(content).toContain('// discord');
    expect(content).toContain('// telegram');
    expect(content).toContain('// whatsapp');
  });

  it('modified config.ts preserves all existing exports', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'config.ts'),
      'utf-8',
    );

    // All original exports preserved
    expect(content).toContain('export const ASSISTANT_NAME');
    expect(content).toContain('export const POLL_INTERVAL');
    expect(content).toContain('export const TRIGGER_PATTERN');
    expect(content).toContain('export const CONTAINER_IMAGE');
    expect(content).toContain('export const DATA_DIR');
    expect(content).toContain('export const TIMEZONE');
  });

  it('marmot.ts implements Channel interface correctly', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'marmot.ts'),
      'utf-8',
    );

    // Required Channel methods
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(jid: string, text: string)');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(jid: string)');
    expect(content).toContain('async disconnect()');

    // Registry-based self-registration
    expect(content).toContain("registerChannel('marmot'");
    expect(content).toContain('import { registerChannel');

    // Marmot-specific features
    expect(content).toContain('NostrPoolAdapter');
    expect(content).toContain('NsecSigner');
    expect(content).toContain("marmot:");  // JID prefix
  });

  it('marmot.ts uses correct JID format', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'marmot.ts'),
      'utf-8',
    );

    // JID format: marmot:<group_id_hex>
    expect(content).toContain("const MARMOT_PREFIX = 'marmot:'");
    expect(content).toContain('jid.startsWith(MARMOT_PREFIX)');
  });

  it('config adds Marmot vars to readEnvFile', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'config.ts'),
      'utf-8',
    );

    // readEnvFile must include Marmot keys
    expect(content).toContain("'MARMOT_NOSTR_PRIVATE_KEY'");
    expect(content).toContain("'MARMOT_NOSTR_RELAYS'");
    expect(content).toContain("'MARMOT_POLL_INTERVAL_MS'");

    // Relay parsing
    expect(content).toContain('.split');
    expect(content).toContain('.trim()');
  });
});
