import { describe, it, expect } from "vitest";
import { deriveBestBid, deriveBestAsk } from "../utils/orderBook";
import type { BookEntry } from "../types";

describe("deriveBestBid", () => {
  it("returns highest price from unsorted bids", () => {
    const bids: BookEntry[] = [
      { price: "0.30", size: "100" },
      { price: "0.55", size: "50" },
      { price: "0.42", size: "200" },
    ];
    expect(deriveBestBid(bids)).toEqual({ price: 0.55, size: "50" });
  });

  it("returns null for empty bids", () => {
    expect(deriveBestBid([])).toBeNull();
  });

  it("filters out NaN and Infinity prices", () => {
    const bids: BookEntry[] = [
      { price: "NaN", size: "100" },
      { price: "Infinity", size: "50" },
      { price: "0.40", size: "200" },
    ];
    expect(deriveBestBid(bids)).toEqual({ price: 0.40, size: "200" });
  });

  it("returns null if all prices are invalid", () => {
    const bids: BookEntry[] = [
      { price: "NaN", size: "100" },
      { price: "not-a-number", size: "50" },
    ];
    expect(deriveBestBid(bids)).toBeNull();
  });

  it("handles single-level orderbook", () => {
    const bids: BookEntry[] = [{ price: "0.65", size: "300" }];
    expect(deriveBestBid(bids)).toEqual({ price: 0.65, size: "300" });
  });
});

describe("deriveBestAsk", () => {
  it("returns lowest price from unsorted asks", () => {
    const asks: BookEntry[] = [
      { price: "0.70", size: "100" },
      { price: "0.45", size: "50" },
      { price: "0.60", size: "200" },
    ];
    expect(deriveBestAsk(asks)).toEqual({ price: 0.45, size: "50" });
  });

  it("returns null for empty asks", () => {
    expect(deriveBestAsk([])).toBeNull();
  });

  it("filters out NaN and negative prices", () => {
    const asks: BookEntry[] = [
      { price: "-0.10", size: "100" },
      { price: "NaN", size: "50" },
      { price: "0.55", size: "200" },
    ];
    expect(deriveBestAsk(asks)).toEqual({ price: 0.55, size: "200" });
  });

  it("handles single-level orderbook", () => {
    const asks: BookEntry[] = [{ price: "0.80", size: "150" }];
    expect(deriveBestAsk(asks)).toEqual({ price: 0.80, size: "150" });
  });
});
