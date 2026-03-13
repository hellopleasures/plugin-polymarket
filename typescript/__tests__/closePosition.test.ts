import { describe, it, expect } from "vitest";
import type { Position } from "../types";

describe("closePosition side detection", () => {
  function findPosition(positions: Position[], tokenId: string): Position | undefined {
    return positions.find((p) => p.asset_id === tokenId);
  }

  function hasNonZeroPosition(position: Position | undefined): boolean {
    if (!position) return false;
    return parseFloat(position.size) > 0;
  }

  const mockPositions: Position[] = [
    { market: "0xcondition1", asset_id: "0xyes_token_1", size: "100", average_price: "0.6500", realized_pnl: "0.000000", unrealized_pnl: "0.000000" },
    { market: "0xcondition2", asset_id: "0xno_token_2", size: "50", average_price: "0.3000", realized_pnl: "5.250000", unrealized_pnl: "0.000000" },
    { market: "0xcondition3", asset_id: "0xempty_token", size: "0", average_price: "0.5000", realized_pnl: "10.000000", unrealized_pnl: "0.000000" },
  ];

  it("finds YES token position by asset_id", () => {
    const pos = findPosition(mockPositions, "0xyes_token_1");
    expect(pos).toBeDefined();
    expect(pos!.size).toBe("100");
    expect(hasNonZeroPosition(pos)).toBe(true);
  });

  it("finds NO token position by asset_id", () => {
    const pos = findPosition(mockPositions, "0xno_token_2");
    expect(pos).toBeDefined();
    expect(pos!.size).toBe("50");
    expect(hasNonZeroPosition(pos)).toBe(true);
  });

  it("returns undefined for unknown token", () => {
    const pos = findPosition(mockPositions, "0xnonexistent");
    expect(pos).toBeUndefined();
    expect(hasNonZeroPosition(pos)).toBe(false);
  });

  it("detects zero-size position as non-closeable", () => {
    const pos = findPosition(mockPositions, "0xempty_token");
    expect(pos).toBeDefined();
    expect(hasNonZeroPosition(pos)).toBe(false);
  });
});
