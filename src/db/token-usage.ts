import { getDb } from './connection.js';

export function logTokenUsage(groupFolder: string, chatJid: string, inputTokens: number, outputTokens: number): void {
  getDb()
    .prepare(
      `INSERT INTO token_usage (group_folder, chat_jid, run_at, input_tokens, output_tokens)
       VALUES (?, ?, datetime('now'), ?, ?)`,
    )
    .run(groupFolder, chatJid, inputTokens, outputTokens);
}
