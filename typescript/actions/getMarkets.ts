/**
 * @elizaos/plugin-polymarket Market Retrieval Actions
 *
 * Actions for fetching market data from Polymarket CLOB.
 */

import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import { getMarketTemplate, retrieveAllMarketsTemplate } from "../templates";
import type {
  Market,
  MarketDetailsActivityData,
  MarketFilters,
  MarketsActivityData,
  SimplifiedMarket,
} from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

// =============================================================================
// Type Definitions
// =============================================================================

interface LLMMarketResult {
  marketId?: string;
  query?: string;
  tokenId?: string;
  error?: string;
}

type SamplingMode = "random" | "rewards";

interface LLMMarketsQuery extends MarketFilters {
  simplified?: boolean;
  sampling?: boolean;
  sampling_mode?: SamplingMode;
  error?: string;
}

interface SimplifiedMarketView {
  condition_id: string;
  question: string;
  active: boolean;
  closed: boolean;
  end_date?: string;
  outcomes: number;
}

function normalizeCategory(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function collectCategories(markets: Market[]): string[] {
  const categories = new Set<string>();
  markets.forEach((market) => {
    const normalized = normalizeCategory(market.category);
    if (normalized) {
      categories.add(normalized);
    }
  });
  return [...categories].sort((a, b) => a.localeCompare(b));
}

export const retrieveAllMarketsAction: Action = {
  name: "POLYMARKET_GET_MARKETS",
  similes: [
    "GET_MARKETS",
    "LIST_MARKETS",
    "SHOW_MARKETS",
    "FETCH_MARKETS",
    "POLYMARKET_MARKETS",
    "ALL_MARKETS",
    "BROWSE_MARKETS",
    "VIEW_MARKETS",
  ],
  description:
    "Lists Polymarket markets with optional filters and view modes. Use when the user asks to browse markets by category or status, wants a simplified overview, or asks for a random sample. For larger listings, use next_cursor pagination and limit controls. Parameters: category (optional), active (optional boolean), limit (optional number), simplified (optional boolean), sampling (optional boolean), sampling_mode (optional: random|rewards).",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");
    if (!clobApiUrl) {
      runtime.logger.warn("[retrieveAllMarketsAction] CLOB_API_URL is required");
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const llmResult = await callLLMWithTimeout<LLMMarketsQuery>(
      runtime,
      state,
      retrieveAllMarketsTemplate,
      "retrieveAllMarketsAction"
    );

    const filters: MarketFilters = {};
    let simplified = false;
    let sampling = false;
    let samplingMode: SamplingMode | undefined;
    if (llmResult && !isLLMError(llmResult)) {
      if (llmResult.category) filters.category = llmResult.category;
      if (llmResult.active !== undefined) filters.active = llmResult.active;
      if (llmResult.limit) filters.limit = llmResult.limit;
      if (llmResult.next_cursor) filters.next_cursor = llmResult.next_cursor;
      if (llmResult.simplified !== undefined) simplified = llmResult.simplified;
      if (llmResult.sampling !== undefined) sampling = llmResult.sampling;
      if (llmResult.sampling_mode) samplingMode = llmResult.sampling_mode;
    }

    const clobClient = await initializeClobClient(runtime);
    const requestText = message.content?.text?.toLowerCase() ?? "";
    const wantsRewardsSampling = /reward|rewards|incentive|sampling reward/.test(requestText);
    if (samplingMode && !sampling) {
      sampling = true;
    }
    if (sampling && !samplingMode) {
      samplingMode = wantsRewardsSampling ? "rewards" : "random";
    }

    // Get the service for activity recording
    const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;

    if (sampling && samplingMode === "rewards") {
      const response = await clobClient.getSamplingMarkets(filters.next_cursor);
      const markets = response.data as SimplifiedMarket[];
      const limit = filters.limit ?? 10;
      const limitedMarkets = markets.slice(0, limit);

      let responseText = `🎯 **Sampling Markets (Rewards Enabled)** (${limitedMarkets.length} results)\n\n`;

      limitedMarkets.forEach((market, index) => {
        responseText += `${index + 1}. Condition: \`${market.condition_id.slice(0, 16)}...\`\n`;
        responseText += `   Min Incentive Size: ${market.min_incentive_size}\n`;
        responseText += `   Max Incentive Spread: ${market.max_incentive_spread}\n\n`;
      });

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_MARKETS"],
      };

      if (callback) {
        await callback(responseContent);
      }

      // Record activity
      if (service) {
        const activityData: MarketsActivityData = {
          type: "markets_list",
          mode: "sampling_rewards",
          count: limitedMarkets.length,
          markets: limitedMarkets.map((m) => ({
            conditionId: m.condition_id,
            question: m.condition_id, // Sampling markets don't have question
            active: m.active,
            closed: m.closed,
          })),
          nextCursor: response.next_cursor,
        };
        await service.recordActivity(activityData);
      }

      return {
        success: true,
        text: responseText,
        data: {
          count: String(limitedMarkets.length),
          nextCursor: response.next_cursor ?? "",
          timestamp: new Date().toISOString(),
          mode: "sampling_rewards",
        },
      };
    }

    const response = await clobClient.getMarkets(filters.next_cursor);
    const markets = response.data as Market[];

    // Apply client-side filters if needed
    let filteredMarkets = markets;
    if (filters.category) {
      const desiredCategory = normalizeCategory(filters.category);
      if (desiredCategory) {
        const applyCategoryFilter = (value: string, marketCategory?: string | null): boolean => {
          const normalizedMarketCategory = normalizeCategory(marketCategory);
          if (!normalizedMarketCategory) {
            return false;
          }
          if (normalizedMarketCategory === value) {
            return true;
          }
          return normalizedMarketCategory.includes(value) || value.includes(normalizedMarketCategory);
        };

        const categoryFiltered = filteredMarkets.filter((market) =>
          applyCategoryFilter(desiredCategory, market.category)
        );

        if (categoryFiltered.length > 0) {
          filteredMarkets = categoryFiltered;
        } else {
          const availableCategories = collectCategories(markets);
          let responseText =
            `📊 **Polymarket Markets** (0 results)\n\n` +
            `No markets found for category "${filters.category}".\n\n`;
          if (availableCategories.length > 0) {
            responseText += `Available categories:\n`;
            responseText += availableCategories.map((cat) => `• ${cat}`).join("\n");
            responseText += `\n\nChoose one of the categories above and try again.`;
          } else {
            responseText += `No categories are available from the current response. Try again without a category filter.`;
          }

          const responseContent: Content = {
            text: responseText,
            actions: ["POLYMARKET_GET_MARKETS"],
          };

          if (callback) {
            await callback(responseContent);
          }

          return {
            success: true,
            text: responseText,
            data: {
              count: "0",
              nextCursor: response.next_cursor ?? "",
              timestamp: new Date().toISOString(),
              mode: "category_enforced",
              categories: availableCategories,
            },
          };
        }
      }
    }
    if (filters.active !== undefined) {
      filteredMarkets = filteredMarkets.filter((m) => m.active === filters.active);
    }

    if (sampling && samplingMode === "random") {
      const limit = filters.limit ?? 5;
      const shuffled = [...filteredMarkets].sort(() => Math.random() - 0.5);
      const sampledMarkets = shuffled.slice(0, limit);

      let responseText = `🎲 **Sample Polymarket Markets**:\n\n`;

      if (sampledMarkets.length > 0) {
        responseText += `Here are ${sampledMarkets.length} randomly sampled market(s):\n\n`;
        sampledMarkets.forEach((market, index) => {
          const statusEmoji = market.active && !market.closed ? "🟢" : "🔴";
          responseText += `**${index + 1}. ${market.question || market.condition_id}** ${statusEmoji}\n`;
          responseText += `   • **Condition ID**: \`${market.condition_id}\`\n`;
          responseText += `   • **Active**: ${market.active ? "Yes" : "No"}\n`;
          responseText += `   • **Closed**: ${market.closed ? "Yes" : "No"}\n`;
          if (market.end_date_iso) {
            responseText += `   • **End Date**: ${new Date(
              market.end_date_iso
            ).toLocaleString()}\n`;
          }
          if (market.tokens && market.tokens.length > 0) {
            responseText += `   • **Outcomes**: ${market.tokens.length}\n`;
          }
          responseText += `\n`;
        });

        responseText += `\n💡 *These are randomly sampled markets. Run again for different results.*\n`;
        if (response.next_cursor) {
          responseText += `*More markets available with cursor: \`${response.next_cursor}\`*\n`;
        }
      } else {
        responseText += `No markets found to sample.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_MARKETS"],
      };

      if (callback) {
        await callback(responseContent);
      }

      // Record activity
      if (service && sampledMarkets.length > 0) {
        const activityData: MarketsActivityData = {
          type: "markets_list",
          mode: "sampling_random",
          count: sampledMarkets.length,
          category: filters.category,
          markets: sampledMarkets.map((m) => ({
            conditionId: m.condition_id,
            question: m.question || m.condition_id,
            active: m.active ?? false,
            closed: m.closed ?? false,
          })),
          nextCursor: response.next_cursor,
        };
        await service.recordActivity(activityData);
      }

      return {
        success: true,
        text: responseText,
        data: {
          count: String(sampledMarkets.length),
          limit: String(limit),
          nextCursor: response.next_cursor ?? "",
          timestamp: new Date().toISOString(),
          mode: "sampling_random",
        },
      };
    }

    if (simplified) {
      const limit = filters.limit ?? 10;
      const simplifiedMarkets: SimplifiedMarketView[] = filteredMarkets
        .slice(0, limit)
        .map((market) => ({
          condition_id: market.condition_id,
          question: market.question || "N/A",
          active: market.active ?? false,
          closed: market.closed ?? false,
          end_date: market.end_date_iso,
          outcomes: market.tokens?.length || 0,
        }));

      let responseText = `📋 **Simplified Polymarket Markets**:\n\n`;

      if (simplifiedMarkets.length > 0) {
        responseText += `Showing ${simplifiedMarkets.length} market(s):\n\n`;
        simplifiedMarkets.forEach((market, index) => {
          const statusEmoji = market.active && !market.closed ? "🟢" : "🔴";
          responseText += `**${index + 1}.** ${statusEmoji} ${market.question}\n`;
          responseText += `   ID: \`${market.condition_id.substring(0, 12)}...\` | Outcomes: ${market.outcomes}`;
          if (market.end_date) {
            responseText += ` | Ends: ${new Date(market.end_date).toLocaleDateString()}`;
          }
          responseText += `\n\n`;
        });

        if (response.next_cursor) {
          responseText += `\n📄 *More markets available. Use cursor: \`${response.next_cursor}\`*\n`;
        }
      } else {
        responseText += `No markets found.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_MARKETS"],
      };

      if (callback) {
        await callback(responseContent);
      }

      // Record activity
      if (service && simplifiedMarkets.length > 0) {
        const activityData: MarketsActivityData = {
          type: "markets_list",
          mode: "simplified",
          count: simplifiedMarkets.length,
          category: filters.category,
          activeOnly: filters.active,
          markets: simplifiedMarkets.map((m) => ({
            conditionId: m.condition_id,
            question: m.question,
            active: m.active,
            closed: m.closed,
          })),
          nextCursor: response.next_cursor,
        };
        await service.recordActivity(activityData);
      }

      return {
        success: true,
        text: responseText,
        data: {
          count: String(simplifiedMarkets.length),
          limit: String(limit),
          nextCursor: response.next_cursor ?? "",
          timestamp: new Date().toISOString(),
          mode: "simplified",
        },
      };
    }

    if (filters.limit) {
      filteredMarkets = filteredMarkets.slice(0, filters.limit);
    }

    // Format response
    let responseText = `📊 **Polymarket Markets** (${filteredMarkets.length} results)\n\n`;

    if (filteredMarkets.length === 0) {
      responseText += "No markets found matching your criteria.";
    } else {
      filteredMarkets.slice(0, 10).forEach((market, index) => {
        responseText += `**${index + 1}. ${market.question}**\n`;
        responseText += `   • Category: ${market.category}\n`;
        responseText += `   • Active: ${market.active ? "✅" : "❌"}\n`;
        responseText += `   • ID: \`${market.condition_id.slice(0, 20)}...\`\n\n`;
      });

      if (filteredMarkets.length > 10) {
        responseText += `\n_...and ${filteredMarkets.length - 10} more markets_`;
      }
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_MARKETS"],
    };

    if (callback) {
      await callback(responseContent);
    }

    // Record activity
    if (service && filteredMarkets.length > 0) {
      const activityData: MarketsActivityData = {
        type: "markets_list",
        mode: "standard",
        count: filteredMarkets.length,
        category: filters.category,
        activeOnly: filters.active,
        markets: filteredMarkets.slice(0, 10).map((m) => ({
          conditionId: m.condition_id,
          question: m.question || m.condition_id,
          active: m.active ?? false,
          closed: m.closed ?? false,
        })),
        nextCursor: response.next_cursor,
      };
      await service.recordActivity(activityData);
    }

    return {
      success: true,
      text: responseText,
      data: {
        count: String(filteredMarkets.length),
        nextCursor: response.next_cursor ?? "",
        timestamp: new Date().toISOString(),
        mode: "standard",
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the active prediction markets on Polymarket",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the active prediction markets from Polymarket for you.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What crypto markets are available?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Let me get the crypto category markets from Polymarket.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Give me every market you have, even closed ones." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That’s a full catalog request. I can page through markets with a cursor to deliver a larger listing.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show me a simplified list of markets." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I’ll fetch a simplified market overview from Polymarket.",
          action: "POLYMARKET_GET_MARKETS",
          parameters: { simplified: true },
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Give me a random sample of markets." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I’ll sample a few markets from Polymarket.",
          action: "POLYMARKET_GET_MARKETS",
          parameters: { sampling: true, sampling_mode: "random" },
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show reward sampling markets." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching reward-enabled sampling markets from Polymarket.",
          action: "POLYMARKET_GET_MARKETS",
          parameters: { sampling: true, sampling_mode: "rewards" },
        },
      },
    ],
  ],
};

export const getMarketDetailsAction: Action = {
  name: "POLYMARKET_GET_MARKET_DETAILS",
  similes: [
    "GET_MARKET",
    "MARKET_DETAILS",
    "SHOW_MARKET",
    "FETCH_MARKET",
    "MARKET_INFO",
    "FIND_MARKET",
    "LOOKUP_MARKET",
  ],
  description:
    "Retrieves detailed information for a single market by condition ID. Use when the user supplies a condition ID or a valid 0x condition hash. Do not use for browsing or searching; use retrieveAllMarketsAction with a simplified or standard view instead. Parameters: marketId/conditionId (required).",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getSetting("CLOB_API_URL"));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const llmResult = await callLLMWithTimeout<LLMMarketResult>(
      runtime,
      state,
      getMarketTemplate,
      "getMarketDetailsAction"
    );

    if (isLLMError(llmResult)) {
      throw new Error("Market identifier not found. Please specify a condition ID.");
    }

    let conditionId = llmResult?.marketId ?? "";

    if (!conditionId) {
      const fallbackId = llmResult?.query ?? llmResult?.tokenId ?? "";
      if (fallbackId && /^0x[a-fA-F0-9]{64}$/.test(fallbackId)) {
        conditionId = fallbackId;
      } else {
        throw new Error("No valid condition ID found");
      }
    }

    const clobClient = await initializeClobClient(runtime);
    const market = (await clobClient.getMarket(conditionId)) as Market;

    if (!market) {
      throw new Error(`Market not found for condition ID: ${conditionId}`);
    }

    let responseText = `📊 **Market Details**\n\n`;
    responseText += `**${market.question}**\n\n`;
    responseText += `**Market Information:**\n`;
    responseText += `• Condition ID: \`${market.condition_id}\`\n`;
    responseText += `• Category: ${market.category}\n`;
    responseText += `• Active: ${market.active ? "✅" : "❌"}\n`;
    responseText += `• Closed: ${market.closed ? "✅" : "❌"}\n`;

    if (market.end_date_iso) {
      responseText += `• End Date: ${new Date(market.end_date_iso).toLocaleDateString()}\n`;
    }

    responseText += `\n**Trading Details:**\n`;
    responseText += `• Min Order Size: ${market.minimum_order_size}\n`;
    responseText += `• Min Tick Size: ${market.minimum_tick_size}\n`;

    if (market.tokens?.length >= 2) {
      responseText += `\n**Outcome Tokens:**\n`;
      market.tokens.forEach((token) => {
        responseText += `• ${token.outcome}: \`${token.token_id}\`\n`;
      });
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_MARKET_DETAILS"],
    };

    if (callback) {
      await callback(responseContent);
    }

    // Record activity
    const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;
    if (service) {
      const activityData: MarketDetailsActivityData = {
        type: "market_details",
        conditionId: market.condition_id,
        question: market.question || "",
        category: market.category || "",
        active: market.active ?? false,
        closed: market.closed ?? false,
        tokens: market.tokens?.map((t) => ({
          tokenId: t.token_id,
          outcome: t.outcome,
        })),
      };
      await service.recordActivity(activityData);
    }

    return {
      success: true,
      text: responseText,
      data: {
        conditionId,
        question: market.question ?? "",
        active: String(market.active),
        closed: String(market.closed),
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me details for market 0x123abc..." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll retrieve the market details from Polymarket.",
          action: "POLYMARKET_GET_MARKET_DETAILS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Find some random markets to explore." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That’s better served by sampling or listing markets rather than a single-market lookup.",
        },
      },
    ],
  ],
};

