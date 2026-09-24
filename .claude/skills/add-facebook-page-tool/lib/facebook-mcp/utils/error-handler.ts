import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// NanoClaw patch: upstream (lmtNoLimit/mcp-facebook) echoed err.stack back into
// the tool result on failure. Stack traces can leak local file paths and are
// pure noise to the model — dropped. See THIRD_PARTY_NOTICE.md.
const createErrorResponse = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const wrapToolHandler = (
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> =>
  fn().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return createErrorResponse(message);
  });

export { createErrorResponse, wrapToolHandler };
