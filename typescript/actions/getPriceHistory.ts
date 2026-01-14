import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import { getPriceHistoryTemplate } from "../templates";
import type { PriceHistoryActivityData } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMPriceHistoryResult {
  tokenId?: string;
  startTs?: number;
  endTs?: number;
  fidelity?: number;
  error?: string;
}

interface PriceHistoryPoint {
  t: number;
  p: string;
}

type PriceHistoryResponse = PriceHistoryPoint[];

/**
 * Type assertion helper for Polymarket API responses.
 * The CLOB client library doesn't expose proper return types for getPricesHistory.
 */
function asPriceHistoryResponse(response: unknown): PriceHistoryResponse {
  return response as PriceHistoryResponse;
}

/**
 * Get Price History Action for Polymarket.
 * Retrieves historical prices for a specific token over a time range.
 */
export const getPriceHistoryAction: Action = {
  name: "POLYMARKET_GET_PRICE_HISTORY",
  similes: ["HISTORICAL_PRICES", "PRICE_CHART", "TOKEN_PRICE_HISTORY", "PRICE_DATA"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Retrieves historical prices for a token over a time range. Use when the user asks for price history, charts, or time-series data. Do not use for current order book metrics; use POLYMARKET_GET_ORDER_BOOK for best price, spread, or midpoint snapshots. Parameters: tokenId (required), startTs/endTs (optional unix seconds), fidelity (optional interval).",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    runtime.logger.info(
      `[getPriceHistoryAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      runtime.logger.warn("[getPriceHistoryAction] CLOB_API_URL is required.");
      return false;
    }
    runtime.logger.info("[getPriceHistoryAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    runtime.logger.info("[getPriceHistoryAction] Handler called!");

    const result = await callLLMWithTimeout<LLMPriceHistoryResult>(
      runtime,
      state,
      getPriceHistoryTemplate,
      "getPriceHistoryAction"
    );
    let llmResult: LLMPriceHistoryResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    runtime.logger.info(`[getPriceHistoryAction] LLM result: ${JSON.stringify(llmResult)}`);

    if (llmResult.error || !llmResult.tokenId) {
      throw new Error(llmResult.error || "Token ID not found in LLM result.");
    }

    const tokenId = llmResult.tokenId;
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400; // Default to last 24 hours
    const startTs = llmResult.startTs || oneDayAgo;
    const endTs = llmResult.endTs || now;
    const fidelity = llmResult.fidelity || 60; // Default to 60-minute intervals

    runtime.logger.info(
      `[getPriceHistoryAction] Fetching price history for token: ${tokenId} from ${startTs} to ${endTs} with fidelity ${fidelity}`
    );

    const client = (await initializeClobClient(runtime)) as ClobClient;
    const priceHistory = asPriceHistoryResponse(
      await client.getPricesHistory({
        market: tokenId,
        startTs,
        endTs,
        fidelity,
      })
    );

    let responseText = `📈 **Price History for Token ${tokenId}**:\n\n`;

    if (priceHistory && priceHistory.length > 0) {
      responseText += `Retrieved ${priceHistory.length} data point(s):\n\n`;

      // Show first and last few points
      const showCount = Math.min(5, priceHistory.length);
      const firstPoints = priceHistory.slice(0, showCount);
      const lastPoints = priceHistory.length > showCount * 2 ? priceHistory.slice(-showCount) : [];

      responseText += `**First ${showCount} Points:**\n`;
      firstPoints.forEach((point: PriceHistoryPoint) => {
        const date = new Date(point.t * 1000).toLocaleString();
        responseText += `• ${date}: $${parseFloat(point.p).toFixed(4)}\n`;
      });

      if (lastPoints.length > 0) {
        responseText += `\n**Last ${showCount} Points:**\n`;
        lastPoints.forEach((point: PriceHistoryPoint) => {
          const date = new Date(point.t * 1000).toLocaleString();
          responseText += `• ${date}: $${parseFloat(point.p).toFixed(4)}\n`;
        });
      }

      if (priceHistory.length > showCount * 2) {
        responseText += `\n*... and ${priceHistory.length - showCount * 2} more data points.*\n`;
      }

      // Calculate price change
      const startPrice = parseFloat(priceHistory[0].p);
      const endPrice = parseFloat(priceHistory[priceHistory.length - 1].p);
      const priceChange = endPrice - startPrice;
      const priceChangePercent = ((priceChange / startPrice) * 100).toFixed(2);
      const changeEmoji = priceChange >= 0 ? "📈" : "📉";

      responseText += `\n**Summary:**\n`;
      responseText += `• Start Price: $${startPrice.toFixed(4)}\n`;
      responseText += `• End Price: $${endPrice.toFixed(4)}\n`;
      responseText += `• Change: ${changeEmoji} ${priceChange >= 0 ? "+" : ""}$${priceChange.toFixed(4)} (${priceChangePercent}%)\n`;
    } else {
      responseText += `No price history found for the specified time range.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["GET_PRICE_HISTORY"],
    };

    if (callback) await callback(responseContent);

    // Record activity
    const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;
    if (service && priceHistory.length > 0) {
      const startPrice = parseFloat(priceHistory[0].p);
      const endPrice = parseFloat(priceHistory[priceHistory.length - 1].p);
      const priceChange = endPrice - startPrice;
      const priceChangePercent = ((priceChange / startPrice) * 100).toFixed(2);

      const activityData: PriceHistoryActivityData = {
        type: "price_history",
        tokenId,
        dataPoints: priceHistory.length,
        startTs,
        endTs,
        startPrice: startPrice.toFixed(4),
        endPrice: endPrice.toFixed(4),
        priceChangePercent,
      };
      await service.recordActivity(activityData);
    }

    return {
      success: true,
      text: responseText,
      data: {
        tokenId,
        dataPoints: String(priceHistory.length),
        startTs: String(startTs),
        endTs: String(endTs),
        fidelity: String(fidelity),
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show price history for token xyz123 on Polymarket." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching price history for token xyz123 on Polymarket...",
          action: "POLYMARKET_GET_PRICE_HISTORY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Get the historical prices for token 0xabc789 over the last week via Polymarket.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up historical prices for token 0xabc789 on Polymarket...",
          action: "POLYMARKET_GET_PRICE_HISTORY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What’s the best ask right now for token 0xabc789?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That’s a real-time top-of-book request, not a historical chart. I can fetch the best price from the order book.",
        },
      },
    ],
  ],
};
