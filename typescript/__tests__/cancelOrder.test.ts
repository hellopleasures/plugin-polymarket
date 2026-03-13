import { describe, it, expect } from "vitest";

describe("cancelOrder parameter extraction", () => {
  function extractCancelParams(text: string) {
    const cancelAll = /cancel\s+(all|every)\s+(my\s+)?orders/i.test(text);
    const orderIdMatch = text.match(/cancel\s+order\s+([a-f0-9-]{8,})/i);
    const tokenMatch = text.match(/cancel\s+(?:orders?\s+(?:on|for)\s+)?(?:token\s+)?(0x[a-f0-9]{8,})/i);

    return {
      cancelAll,
      orderId: orderIdMatch?.[1] ?? null,
      tokenId: tokenMatch?.[1] ?? null,
    };
  }

  it("detects cancel all intent", () => {
    expect(extractCancelParams("cancel all my orders").cancelAll).toBe(true);
    expect(extractCancelParams("cancel every orders").cancelAll).toBe(true);
  });

  it("extracts specific order ID", () => {
    const result = extractCancelParams("cancel order abc12345-def6-7890");
    expect(result.orderId).toBe("abc12345-def6-7890");
  });

  it("extracts token ID", () => {
    const result = extractCancelParams("cancel orders on token 0x1234abcd5678ef90");
    expect(result.tokenId).toBe("0x1234abcd5678ef90");
  });

  it("returns nulls for unrecognized input", () => {
    const result = extractCancelParams("hello world");
    expect(result.cancelAll).toBe(false);
    expect(result.orderId).toBeNull();
    expect(result.tokenId).toBeNull();
  });
});
