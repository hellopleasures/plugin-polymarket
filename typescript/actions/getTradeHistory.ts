import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import { getTradeHistoryTemplate } from "../templates";
import type { GetTradesParams, TradeEntry, TradeHistoryActivityData } from "../types";
import { initializeClobClientWithCreds } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

/**
 * Type assertion helper for trades from Polymarket API.
 * The CLOB client library's Trade type differs from our TradeEntry interface.
 */
function asTradeEntries(trades: unknown): TradeEntry[] {
  return (trades ?? []) as TradeEntry[];
}

interface LLMTradeHistoryResult {
  market?: string;
  assetId?: string;
  limit?: number;
  error?: string;
}

/**
 * Get Trade History Action for Polymarket.
 * Retrieves the authenticated user's trade history.
 */
export const getTradeHistoryAction: Action = {
  name: "POLYMARKET_GET_TRADE_HISTORY",
  similes: ["MY_TRADES", "TRADE_LOG", "FILLED_ORDERS", "PAST_TRADES", "TRADING_HISTORY"].map(
    (s) => `POLYMARKET_${s}`,
  ),
  description:
    "Retrieves the authenticated user's filled trade history, optionally filtered by market or asset. Use when the user asks for past trades or fills. Do not use for open orders or a specific order status; use getActiveOrdersAction or getOrderDetailsAction. Parameters: market (optional slug), assetId (optional token ID), limit (optional). Requires full CLOB credentials.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["polymarket", "get", "trade", "history"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:polymarket|get|trade|history)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: any,
      message: any,
      state?: any,
      options?: any,
    ): Promise<boolean> => {
      const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
      const __avText = __avTextRaw.toLowerCase();
      const __avKeywords = ["polymarket", "get", "trade", "history"];
      const __avKeywordOk =
        __avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
      const __avRegexOk = /\b(?:polymarket|get|trade|history)\b/i.test(__avText);
      const __avSource = String(message?.content?.source ?? message?.source ?? "");
      const __avExpectedSource = "";
      const __avSourceOk = __avExpectedSource
        ? __avSource === __avExpectedSource
        : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
      const __avOptions = options && typeof options === "object" ? options : {};
      const __avInputOk =
        __avText.trim().length > 0 ||
        Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
        Boolean(message?.content && typeof message.content === "object");

      if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
        return false;
      }

      const __avLegacyValidate = async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
      ): Promise<boolean> => {
        runtime.logger.info(
          `[getTradeHistoryAction] Validate called for message: "${message.content?.text}"`,
        );
        const clobApiUrl = runtime.getSetting("CLOB_API_URL");
        const clobApiKey = runtime.getSetting("CLOB_API_KEY");
        const clobApiSecret =
          runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
        const clobApiPassphrase =
          runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");
        const privateKey =
          runtime.getSetting("WALLET_PRIVATE_KEY") ||
          runtime.getSetting("PRIVATE_KEY") ||
          runtime.getSetting("POLYMARKET_PRIVATE_KEY");

        if (!clobApiUrl) {
          runtime.logger.warn("[getTradeHistoryAction] CLOB_API_URL is required.");
          return false;
        }
        if (!privateKey) {
          runtime.logger.warn(
            "[getTradeHistoryAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.",
          );
          return false;
        }
        if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
          const missing: string[] = [];
          if (!clobApiKey) missing.push("CLOB_API_KEY");
          if (!clobApiSecret) missing.push("CLOB_API_SECRET or CLOB_SECRET");
          if (!clobApiPassphrase) missing.push("CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE");
          runtime.logger.warn(
            `[getTradeHistoryAction] Missing required API credentials for L2 authentication: ${missing.join(", ")}.`,
          );
          return false;
        }
        runtime.logger.info("[getTradeHistoryAction] Validation passed");
        return true;
      };
      try {
        return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
      } catch {
        return false;
      }
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    runtime.logger.info("[getTradeHistoryAction] Handler called!");

    const result = await callLLMWithTimeout<LLMTradeHistoryResult>(
      runtime,
      state,
      getTradeHistoryTemplate,
      "getTradeHistoryAction",
    );
    let llmResult: LLMTradeHistoryResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    runtime.logger.info(`[getTradeHistoryAction] LLM result: ${JSON.stringify(llmResult)}`);

    const market = llmResult.market;
    const assetId = llmResult.assetId;
    const limit = llmResult.limit || 20;

    const apiParams: GetTradesParams = {};
    if (market) apiParams.market = market;
    if (assetId) apiParams.asset_id = assetId;

    runtime.logger.info(
      `[getTradeHistoryAction] Fetching trade history with params: ${JSON.stringify(apiParams)}`,
    );

    const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
    // Use getTradesPaginated to get pagination info including next_cursor
    const tradesResponse = await client.getTradesPaginated(apiParams);
    const trades = asTradeEntries(tradesResponse.trades);

    let responseText = `📜 **Your Trade History on Polymarket:**\n\n`;

    if (trades && trades.length > 0) {
      responseText += `Found ${trades.length} trade(s):\n\n`;
      const displayTrades = trades.slice(0, limit);
      displayTrades.forEach((trade: TradeEntry, index: number) => {
        const sideEmoji = trade.side === "BUY" ? "🟢" : "🔴";
        responseText += `**${index + 1}. Trade ID: ${trade.id}** ${sideEmoji}\n`;
        responseText += `   • **Side**: ${trade.side}\n`;
        responseText += `   • **Price**: $${parseFloat(trade.price).toFixed(4)}\n`;
        responseText += `   • **Size**: ${trade.size}\n`;
        responseText += `   • **Fee**: $${trade.fee_rate_bps ? ((parseFloat(trade.size) * parseFloat(trade.price) * parseFloat(trade.fee_rate_bps)) / 10000).toFixed(4) : "N/A"}\n`;
        responseText += `   • **Status**: ${trade.status || "MATCHED"}\n`;
        if (trade.match_time) {
          responseText += `   • **Time**: ${new Date(trade.match_time).toLocaleString()}\n`;
        }
        responseText += `\n`;
      });

      if (trades.length > limit) {
        responseText += `\n📄 *Showing ${limit} of ${trades.length} trades.*\n`;
      }
      if (tradesResponse?.next_cursor) {
        responseText += `*More trades available. Use cursor: \`${tradesResponse.next_cursor}\`*\n`;
      }
    } else {
      responseText += `You have no trades in your history.\n`;
      if (market) responseText += ` (Filtered by market: ${market})`;
      if (assetId) responseText += ` (Filtered by asset_id: ${assetId})`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_TRADE_HISTORY"],
    };

    if (callback) await callback(responseContent);

    // Record activity
    const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;
    if (service) {
      const activityData: TradeHistoryActivityData = {
        type: "trade_history",
        totalTrades: trades.length,
        recentTrades: trades.slice(0, 5).map((t: TradeEntry) => ({
          tradeId: t.id,
          side: t.side,
          price: t.price,
          size: t.size,
          market: t.market,
        })),
        filterMarket: market,
        filterAssetId: assetId,
        nextCursor: tradesResponse?.next_cursor,
      };
      await service.recordActivity(activityData);
    }

    return {
      success: true,
      text: responseText,
      data: {
        totalTrades: String(trades.length),
        nextCursor: tradesResponse?.next_cursor ?? "",
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show my trade history on Polymarket." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching your trade history from Polymarket...",
          action: "POLYMARKET_GET_TRADE_HISTORY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What trades have I made on Polymarket?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up your past trades on Polymarket...",
          action: "POLYMARKET_GET_TRADE_HISTORY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Is my order 0xabc still open?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That’s an order-status check rather than trade history. I can look up the order details if you want.",
        },
      },
    ],
  ],
};
