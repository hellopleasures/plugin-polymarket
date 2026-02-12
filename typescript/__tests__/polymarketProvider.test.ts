import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { polymarketProvider } from "../providers/polymarket";

type MinimalRuntime = Pick<
  IAgentRuntime,
  "agentId" | "character" | "getSetting" | "getService" | "logger"
>;

function createRuntime(
  settings: Record<string, string | undefined>,
  service?: {
    getCachedAccountState: () => unknown;
    getCachedActivityContext: () => unknown;
  },
): IAgentRuntime {
  const runtime: MinimalRuntime = {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["Test"],
      system: "Test",
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      settings: {},
      style: { all: [], chat: [], post: [] },
    } as never,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(() => service),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    } as never,
  };

  return runtime as IAgentRuntime;
}

describe("polymarketProvider", () => {
  it("returns provider error when service is unavailable in non-strict mode", async () => {
    const runtime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      CLOB_API_KEY: "key",
      CLOB_API_SECRET: "secret",
      CLOB_API_PASSPHRASE: "pass",
      POLYMARKET_PRIVATE_KEY: "0xabc",
      POLYMARKET_PROVIDER_STRICT: "false",
    });

    const result = await polymarketProvider.get(runtime, {} as never, {} as never);
    expect(result.values?.providerError).toBe("Polymarket service not initialized");
  });

  it("includes cached account state when service cache is present", async () => {
    const runtime = createRuntime(
      {
        CLOB_API_URL: "https://clob.polymarket.com",
        CLOB_API_KEY: "key",
        CLOB_API_SECRET: "secret",
        CLOB_API_PASSPHRASE: "pass",
        POLYMARKET_PRIVATE_KEY: "0xabc",
        POLYMARKET_PROVIDER_STRICT: "true",
      },
      {
        getCachedAccountState: () => ({
          walletAddress: "0xwallet",
          balances: {
            collateral: { balance: "100", allowance: "1000" },
            conditionalTokens: {},
          },
          recentTrades: [{ id: "t1" }],
          activeOrders: [{ id: "o1" }],
          positions: [{ asset_id: "a1" }],
          orderScoringStatus: { o1: true },
          apiKeys: [{ key: "k1" }],
          certRequired: false,
          lastUpdatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
        getCachedActivityContext: () => ({ recentHistory: [] }),
      },
    );

    const result = await polymarketProvider.get(runtime, {} as never, {} as never);
    expect(result.values?.collateralBalance).toBeDefined();
    expect(result.values?.recentTrades).toBeDefined();
    expect(result.values?.activeOrders).toBeDefined();
    expect(result.values?.positions).toBeDefined();
  });
});
