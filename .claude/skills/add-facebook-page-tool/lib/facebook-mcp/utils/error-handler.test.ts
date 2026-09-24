import { describe, expect, test } from "bun:test";
import { createErrorResponse, wrapToolHandler } from "./error-handler.js";

describe("createErrorResponse", () => {
  test("returns an isError result with just the message, no stack", () => {
    const result = createErrorResponse("something broke");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "something broke" });
  });
});

describe("wrapToolHandler", () => {
  test("passes through a successful result unchanged", async () => {
    const result = await wrapToolHandler(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "text", text: "ok" });
  });

  test("catches a thrown Error and never leaks its stack into the result", async () => {
    const result = await wrapToolHandler(async () => {
      throw new Error("Graph API error: Invalid OAuth token (code: 190)");
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("Graph API error: Invalid OAuth token (code: 190)");
    expect(text).not.toContain("at "); // no stack frame lines
  });

  test("catches a non-Error throw and stringifies it", async () => {
    const result = await wrapToolHandler(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "plain string failure";
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("plain string failure");
  });
});
