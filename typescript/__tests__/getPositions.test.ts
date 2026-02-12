import { describe, expect, it } from "vitest";

import { polymarketProvider } from "../providers/polymarket";

describe("legacy position actions", () => {
  it("are consolidated into the polymarket provider", () => {
    expect(polymarketProvider).toBeDefined();
    expect(polymarketProvider.description).toContain("account state");
  });
});
