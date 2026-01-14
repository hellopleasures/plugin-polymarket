/**
 * @elizaos/plugin-polymarket Order Book Actions
 *
 * ## Overview
 *
 * These actions provide real-time order book data from the Polymarket CLOB
 * (Central Limit Order Book). The order book represents all outstanding buy
 * and sell orders for a prediction market outcome token.
 *
 * ## What is an Order Book?
 *
 * An order book is a list of buy orders (bids) and sell orders (asks) organized
 * by price level. In Polymarket:
 * - **Bids**: Orders from traders willing to BUY shares at a given price
 * - **Asks**: Orders from traders willing to SELL shares at a given price
 * - **Spread**: The difference between the best (lowest) ask and best (highest) bid
 * - **Midpoint**: The average of the best bid and best ask prices
 *
 * ## Why Use Order Book Data?
 *
 * Order book data helps you:
 * 1. **Understand market liquidity** - How much volume is available at each price
 * 2. **Get fair pricing** - Find the best available prices before trading
 * 3. **Assess market sentiment** - Heavy bid-side suggests bullish sentiment
 * 4. **Plan order placement** - Know where to place limit orders for execution
 * 5. **Compare markets** - Evaluate depth across multiple tokens
 *
 * ## When to Use Each Action
 *
 * ### POLYMARKET_GET_ORDER_BOOK (Consolidated Action)
 * **Use for:** Single-token queries about current market state
 * - Getting a quick snapshot of the order book (summary)
 * - Finding the best available buy or sell price (bestPrice)
 * - Getting the midpoint price for valuation (midpoint)
 * - Checking the bid-ask spread for liquidity assessment (spread)
 *
 * **Example queries:**
 * - "What's the order book for token X?"
 * - "What's the best price to buy token X?"
 * - "What's the spread on token X?"
 *
 * ### POLYMARKET_GET_ORDER_BOOK_DEPTH (Multi-Token Depth)
 * **Use for:** Comparing liquidity depth across multiple tokens
 * - Evaluating which markets have the most liquidity
 * - Finding markets with adequate depth for large orders
 *
 * **Example queries:**
 * - "Compare depth for tokens A, B, and C"
 * - "Which of these markets has more liquidity?"
 *
 * ## When NOT to Use These Actions
 *
 * - **Historical prices**: Use `getPriceHistoryAction` for past price data
 * - **Market discovery**: Use `getMarketsAction` to find markets by topic
 * - **Placing orders**: Use `placeOrderAction` to execute trades
 * - **Position tracking**: Use `getPositionsAction` to see your holdings
 *
 * ## Technical Notes
 *
 * - Order book data is real-time and changes constantly as orders are placed/filled
 * - Prices are quoted in USDC (stablecoin pegged to $1 USD)
 * - Token IDs are the condition token addresses from Polymarket markets
 */

import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { getOrderBookDepthTemplate, getOrderBookTemplate } from "../templates";
import type { OrderBook } from "../types";
import {
  initializeClobClient,
  callLLMWithTimeout,
  isLLMError,
  parseOrderBookParameters,
  inferMetricFromText,
  inferSideFromText,
  resolveTokenIdFromLLM,
  fetchOrderBookSummary,
  type LLMTokensResult,
} from "../utils";

// =============================================================================
// Get Order Book Summary Action
// =============================================================================

/**
 * Consolidated order book action for retrieving real-time market data.
 *
 * This is the primary action for single-token order book queries. It supports
 * multiple metrics through the `metric` parameter:
 *
 * - **summary** (default): Full snapshot with top 5 bids/asks, spread, midpoint
 * - **bestPrice**: Top-of-book price for buying or selling
 * - **midpoint**: Average of best bid and best ask
 * - **spread**: Difference between best ask and best bid
 *
 * ## Usage Examples
 *
 * ```
 * // Get full order book summary
 * { tokenId: "123...", metric: "summary" }
 *
 * // Get best price to buy
 * { tokenId: "123...", metric: "bestPrice", side: "buy" }
 *
 * // Get current spread
 * { tokenId: "123...", metric: "spread" }
 * ```
 *
 * ## When to Use
 *
 * Use this action when you need current market state for a single token:
 * - Before placing an order to understand available prices
 * - To check market liquidity via spread
 * - To get a fair value estimate via midpoint
 *
 * ## When NOT to Use
 *
 * - For historical price data → use `getPriceHistoryAction`
 * - For comparing multiple tokens → use `getOrderBookDepthAction`
 * - For discovering markets → use `getMarketsAction`
 */
export const getOrderBookSummaryAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK",
  similes: [
    "ORDER_BOOK",
    "GET_ORDER_BOOK",
    "SHOW_ORDER_BOOK",
    "BOOK",
    "ORDERS",
    "BEST_PRICE",
    "MIDPOINT",
    "SPREAD",
  ],
  description: `Retrieves real-time order book data for a single Polymarket token.

**What it does:**
Returns the current state of buy orders (bids) and sell orders (asks) for a token, including best prices, spread, and midpoint.

**When to use:**
- Getting current market prices before trading
- Checking bid-ask spread to assess liquidity
- Finding the best available buy or sell price
- Getting midpoint price for fair value estimation

**When NOT to use:**
- Historical price data → use getPriceHistoryAction
- Comparing depth across multiple tokens → use POLYMARKET_GET_ORDER_BOOK_DEPTH
- Finding markets by topic → use getMarketsAction

**Parameters:**
- tokenId (required): Polymarket condition token ID
- metric (optional): summary | bestPrice | midpoint | spread
- side (optional): buy | sell | bid | ask (only for bestPrice metric)`,

  parameters: [
    {
      name: "tokenId",
      description: "Polymarket condition token ID to fetch order book for",
      required: false,
      schema: { type: "string" },
      examples: ["123456", "0xabc123"],
    },
    {
      name: "metric",
      description:
        "Metric to return: summary (full snapshot), bestPrice (top-of-book), midpoint (mid price), spread (bid-ask gap)",
      required: false,
      schema: { type: "string", enum: ["summary", "bestPrice", "midpoint", "spread"] },
      examples: ["summary", "bestPrice"],
    },
    {
      name: "side",
      description:
        "Side for bestPrice metric: buy/ask (price to buy at), sell/bid (price to sell at)",
      required: false,
      schema: { type: "string", enum: ["buy", "sell", "bid", "ask"] },
      examples: ["buy", "sell"],
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getSetting("CLOB_API_URL"));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    runtime.logger.info("[getOrderBookSummaryAction] Handler called");

    let tokenId = "";

    try {
      const parsedOptions = parseOrderBookParameters(options?.parameters);
      if (parsedOptions.tokenId) {
        tokenId = parsedOptions.tokenId;
      } else {
        const llmResult = await resolveTokenIdFromLLM(
          runtime,
          state,
          getOrderBookTemplate,
          "getOrderBookSummaryAction"
        );

        if (llmResult.error || !llmResult.tokenId) {
          throw new Error(llmResult.error || "Token ID not found. Please specify a token ID.");
        }

        tokenId = llmResult.tokenId;
      }

      const orderBook = (await fetchOrderBookSummary(runtime, tokenId)) as OrderBook;

      // Calculate summary stats
      const topBid = orderBook.bids[0];
      const topAsk = orderBook.asks[0];
      const spreadValue =
        topBid && topAsk ? parseFloat(topAsk.price) - parseFloat(topBid.price) : null;
      const spread = spreadValue !== null ? spreadValue.toFixed(4) : "N/A";
      const midpointValue =
        topBid && topAsk ? (parseFloat(topAsk.price) + parseFloat(topBid.price)) / 2 : null;
      const midpoint = midpointValue !== null ? midpointValue.toFixed(4) : "N/A";

      const metric = parsedOptions.metric ?? inferMetricFromText(message.content?.text);
      const side = parsedOptions.side ?? inferSideFromText(message.content?.text) ?? "buy";

      let responseText = `📚 **Order Book for Token ${tokenId.slice(0, 16)}...**\n\n`;

      if (metric === "bestPrice") {
        const normalizedSide = side === "bid" ? "sell" : side === "ask" ? "buy" : side;
        const bestEntry = normalizedSide === "buy" ? topAsk : topBid;
        const bestLabel = normalizedSide === "buy" ? "Best Ask" : "Best Bid";
        responseText += `**${bestLabel}:** ${
          bestEntry ? `$${bestEntry.price} (${bestEntry.size} shares)` : "None"
        }\n`;
      } else if (metric === "midpoint") {
        responseText += `**Midpoint:** ${midpoint === "N/A" ? "N/A" : `$${midpoint}`}\n`;
      } else if (metric === "spread") {
        responseText += `**Spread:** ${spread === "N/A" ? "N/A" : `$${spread}`}\n`;
      } else {
        responseText += `**Summary:**\n`;
        responseText += `• Best Bid: ${topBid ? `$${topBid.price} (${topBid.size} shares)` : "None"}\n`;
        responseText += `• Best Ask: ${topAsk ? `$${topAsk.price} (${topAsk.size} shares)` : "None"}\n`;
        responseText += `• Spread: ${spread}\n`;
        responseText += `• Midpoint: ${midpoint === "N/A" ? "N/A" : `$${midpoint}`}\n\n`;

        responseText += `**Top 5 Bids:**\n`;
        orderBook.bids.slice(0, 5).forEach((bid, i) => {
          responseText += `${i + 1}. $${bid.price} - ${bid.size} shares\n`;
        });

        responseText += `\n**Top 5 Asks:**\n`;
        orderBook.asks.slice(0, 5).forEach((ask, i) => {
          responseText += `${i + 1}. $${ask.price} - ${ask.size} shares\n`;
        });
      }

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_ORDER_BOOK"],
      };

      if (callback) {
        await callback(responseContent);
      }

      return {
        success: true,
        text: responseText,
        data: {
          tokenId,
          metric,
          side,
          bestBid: topBid?.price ?? "N/A",
          bestAsk: topAsk?.price ?? "N/A",
          spread,
          midpoint,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error("[getOrderBookSummaryAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}\n\n**Token ID**: \`${tokenId || "not provided"}\``,
        actions: ["POLYMARKET_GET_ORDER_BOOK"],
        data: { error: errorMessage, tokenId },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me the order book for token 123456" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the order book for that token.",
          action: "POLYMARKET_GET_ORDER_BOOK",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What's the best bid for token 123456?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching the top-of-book best bid for token 123456.",
          action: "POLYMARKET_GET_ORDER_BOOK",
          parameters: { tokenId: "123456", metric: "bestPrice", side: "sell" },
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What's the spread on this market?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll check the bid-ask spread for you.",
          action: "POLYMARKET_GET_ORDER_BOOK",
          parameters: { metric: "spread" },
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show me every bid and ask level for token 123456." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "The order book summary shows the top 5 levels. For full depth across all levels, I can use the depth action instead.",
        },
      },
    ],
  ],
};

// =============================================================================
// Get Order Book Depth Action
// =============================================================================

interface DepthData {
  bids: number;
  asks: number;
}

/**
 * Multi-token order book depth action for comparing liquidity.
 *
 * This action retrieves the number of bid and ask levels for multiple tokens,
 * useful for comparing relative liquidity depth across markets.
 *
 * ## Usage Examples
 *
 * ```
 * // Compare depth across three tokens
 * { tokenIds: ["123...", "456...", "789..."] }
 * ```
 *
 * ## When to Use
 *
 * - Comparing liquidity depth across multiple related markets
 * - Finding which markets have enough depth for large orders
 * - Evaluating market maturity (more levels = more active market)
 *
 * ## When NOT to Use
 *
 * - For single-token queries → use `POLYMARKET_GET_ORDER_BOOK`
 * - For actual prices → use `POLYMARKET_GET_ORDER_BOOK` with bestPrice/midpoint
 * - For trading → use `placeOrderAction`
 */
export const getOrderBookDepthAction: Action = {
  name: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
  similes: ["ORDER_BOOK_DEPTH", "DEPTH", "MARKET_DEPTH", "LIQUIDITY"],
  description: `Retrieves order book depth (number of bid/ask levels) for multiple tokens.

**What it does:**
Returns the count of bid and ask price levels for each token, indicating market depth and liquidity.

**When to use:**
- Comparing liquidity across multiple markets
- Finding markets with sufficient depth for large trades
- Evaluating market activity and maturity

**When NOT to use:**
- Single-token price queries → use POLYMARKET_GET_ORDER_BOOK
- Getting actual prices → use POLYMARKET_GET_ORDER_BOOK with bestPrice metric
- Historical data → use getPriceHistoryAction

**Parameters:**
- tokenIds (required): Array of Polymarket condition token IDs to compare`,

  parameters: [
    {
      name: "tokenIds",
      description: "Array of Polymarket condition token IDs to fetch depth for",
      required: false,
      schema: {
        type: "array",
        items: { type: "string" },
      },
      examples: [["123", "456"]],
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getSetting("CLOB_API_URL"));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    runtime.logger.info("[getOrderBookDepthAction] Handler called");

    let tokenIds: string[] = [];

    try {
      const parsedOptions = parseOrderBookParameters(options?.parameters);
      if (parsedOptions.tokenIds?.length) {
        tokenIds = parsedOptions.tokenIds;
      } else {
        const llmResult = await callLLMWithTimeout<LLMTokensResult>(
          runtime,
          state,
          getOrderBookDepthTemplate,
          "getOrderBookDepthAction"
        );

        if (isLLMError(llmResult) || !llmResult?.tokenIds?.length) {
          throw new Error("Token IDs not found. Please specify token IDs.");
        }

        tokenIds = llmResult.tokenIds;
      }

      const clobClient = await initializeClobClient(runtime);
      // Use getOrderBooks and calculate depth from the result
      // BookParams requires token_id and side, so we need to call for each side
      const bookParams = tokenIds.flatMap((tid) => [
        { token_id: tid, side: "BUY" as const },
        { token_id: tid, side: "SELL" as const },
      ]);
      const orderBooks = await clobClient.getOrderBooks(
        bookParams as Parameters<typeof clobClient.getOrderBooks>[0]
      );
      const depths: Record<string, DepthData> = {};
      // Process results - orderBooks is an array matching bookParams order
      tokenIds.forEach((tid, idx) => {
        const buyBook = orderBooks[idx * 2];
        const sellBook = orderBooks[idx * 2 + 1];
        depths[tid] = {
          bids: (buyBook as OrderBook)?.bids?.length ?? 0,
          asks: (sellBook as OrderBook)?.asks?.length ?? 0,
        };
      });

      let responseText = `📊 **Order Book Depth**\n\n`;

      Object.entries(depths).forEach(([tid, depth]) => {
        responseText += `**Token ${tid.slice(0, 12)}...**\n`;
        responseText += `• Bid Levels: ${depth.bids}\n`;
        responseText += `• Ask Levels: ${depth.asks}\n\n`;
      });

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_GET_ORDER_BOOK_DEPTH"],
      };

      if (callback) {
        await callback(responseContent);
      }

      return {
        success: true,
        text: responseText,
        data: {
          tokenCount: String(tokenIds.length),
          depths,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error("[getOrderBookDepthAction] Error:", error);

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ["POLYMARKET_GET_ORDER_BOOK_DEPTH"],
        data: { error: errorMessage, tokenIds },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Compare depth for tokens 123, 456, 789" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll fetch the order book depth for those tokens to compare liquidity.",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Which of these markets has more liquidity?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll compare the order book depth across those markets.",
          action: "POLYMARKET_GET_ORDER_BOOK_DEPTH",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What's the midpoint price for token 123?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That's a single-token price question. I'll use the order book summary action with the midpoint metric instead.",
        },
      },
    ],
  ],
};
