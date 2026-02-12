import { describe, expect, it } from "vitest";

import { polymarketProvider } from "../providers/polymarket";

describe("legacy account actions", () => {
  it("are consolidated into the polymarket provider", () => {
    expect(polymarketProvider).toBeDefined();
    expect(polymarketProvider.name).toBe("POLYMARKET_PROVIDER");
  });
});
