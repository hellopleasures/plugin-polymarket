import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClient } from '../utils/clobClient';
import { getOrderBookTemplate } from '../templates';
import type { OrderBook } from '../types';

enum Side {
  BUY = 'buy',
  SELL = 'sell',
}

/**
 * Get order book summary for a market token action for Polymarket
 * Fetches bid/ask data for a specific token
 */
export const getOrderBookSummaryAction: Action = {
  name: 'POLYMARKET_GET_ORDER_BOOK',
  similes: [
    'ORDER_BOOK',
    'BOOK_SUMMARY',
    'GET_BOOK',
    'SHOW_BOOK',
    'FETCH_BOOK',
    'ORDER_BOOK_SUMMARY',
    'BOOK_DATA',
    'BID_ASK',
    'MARKET_DEPTH',
    'ORDERBOOK',
  ],
  description: 'Retrieve order book summary (bids and asks) for a specific Polymarket token',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getOrderBookSummaryAction] CLOB_API_URL is required but not provided');
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info('[getOrderBookSummaryAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getOrderBookSummaryAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYMARKET_GET_ORDER_BOOK'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      return {
        text: errorMessage,
        values: {
          success: false,
          error: true,
        },
        data: {
          actionName: 'POLYMARKET_GET_ORDER_BOOK',
          error: errorMessage,
        },
        success: false,
        error: new Error(errorMessage),
      };
    }

    let tokenId = '';

    // Extract token ID using LLM
    try {
      const llmResult = await callLLMWithTimeout<{
        tokenId?: string;
        query?: string;
        error?: string;
      }>(runtime, state, getOrderBookTemplate, 'getOrderBookSummaryAction');

      logger.info('[getOrderBookSummaryAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error) {
        const errorMessage =
          'Token identifier not found. Please specify a token ID for the order book.';
        logger.error(`[getOrderBookSummaryAction] Parameter extraction error: ${errorMessage}`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. For example:
• "Show order book for token 123456"
• "Get order book summary for 789012"
• "ORDER_BOOK 345678"`,
          actions: ['POLYMARKET_GET_ORDER_BOOK'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        return {
          text: errorContent.text,
          values: {
            success: false,
            error: true,
          },
          data: {
            actionName: 'POLYMARKET_GET_ORDER_BOOK',
            error: errorMessage,
          },
          success: false,
          error: new Error(errorMessage),
        };
      }

      tokenId = llmResult?.tokenId || '';

      if (!tokenId || tokenId.trim() === '') {
        // Try to extract from query as fallback
        const fallbackId = llmResult?.query || '';
        if (fallbackId && fallbackId.match(/^\d+$/)) {
          tokenId = fallbackId;
        } else {
          throw new Error('No valid token ID found');
        }
      }
    } catch (error) {
      // Check if this is our specific error message and re-throw it
      if (
        error instanceof Error &&
        error.message ===
          'Token identifier not found. Please specify a token ID for the order book.'
      ) {
        const errorMessage = error.message;
        return {
          text: errorMessage,
          values: {
            success: false,
            error: true,
          },
          data: {
            actionName: 'POLYMARKET_GET_ORDER_BOOK',
            error: errorMessage,
          },
          success: false,
          error: error,
        };
      }

      logger.warn('[getOrderBookSummaryAction] LLM extraction failed, trying regex fallback');

      // Regex fallback - try to extract token ID directly from the message
      const messageText = message.content.text || '';
      const tokenIdMatch = messageText.match(
        /(?:token|TOKEN)\s*(\d+)|ORDER_BOOK\s*(\d+)|(\d{6,})/i
      );

      if (tokenIdMatch) {
        tokenId = tokenIdMatch[1] || tokenIdMatch[2] || tokenIdMatch[3];
        logger.info(`[getOrderBookSummaryAction] Regex fallback extracted token ID: ${tokenId}`);
      } else {
        const errorMessage =
          'Unable to extract token ID from your message. Please provide a valid token ID.';
        logger.error('[getOrderBookSummaryAction] LLM parameter extraction failed:', error);

        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. For example:
• "Show order book for token 123456"
• "Get order book summary for 789012"
• "ORDER_BOOK 345678"`,
          actions: ['POLYMARKET_GET_ORDER_BOOK'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        return {
          text: errorContent.text,
          values: {
            success: false,
            error: true,
          },
          data: {
            actionName: 'POLYMARKET_GET_ORDER_BOOK',
            error: errorMessage,
          },
          success: false,
          error: new Error(errorMessage),
        };
      }
    }

    try {
      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Fetch order book data for both sides
      const [buyBook, sellBook] = await Promise.all([
        clobClient.getOrderBooks([{ token_id: tokenId, side: 'buy' as any }]),
        clobClient.getOrderBooks([{ token_id: tokenId, side: 'sell' as any }]),
      ]);

      if (!buyBook || buyBook.length === 0 || !sellBook || sellBook.length === 0) {
        throw new Error(`Order book not found for token ID: ${tokenId}`);
      }
      const orderBook: OrderBook = {
        ...buyBook[0],
        bids: sellBook[0].bids, // bids are sells from the user's perspective
        asks: buyBook[0].asks, // asks are buys from the user's perspective
      };

      // Calculate summary statistics
      const bidCount = orderBook.bids?.length || 0;
      const askCount = orderBook.asks?.length || 0;
      const bestBid = bidCount > 0 ? orderBook.bids[0] : null;
      const bestAsk = askCount > 0 ? orderBook.asks[0] : null;
      const spread =
        bestBid && bestAsk
          ? (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(4)
          : 'N/A';

      // Calculate total bid/ask sizes
      const totalBidSize = orderBook.bids?.reduce((sum, bid) => sum + parseFloat(bid.size), 0) || 0;
      const totalAskSize = orderBook.asks?.reduce((sum, ask) => sum + parseFloat(ask.size), 0) || 0;

      // Format response text
      let responseText = `📖 **Order Book Summary**\n\n`;

      responseText += `**Token Information:**\n`;
      responseText += `• Token ID: \`${tokenId}\`\n`;
      responseText += `• Market: ${orderBook.market || 'N/A'}\n`;
      responseText += `• Asset ID: ${orderBook.asset_id || 'N/A'}\n\n`;

      responseText += `**Market Depth:**\n`;
      responseText += `• Bid Orders: ${bidCount}\n`;
      responseText += `• Ask Orders: ${askCount}\n`;
      responseText += `• Total Bid Size: ${totalBidSize.toFixed(2)}\n`;
      responseText += `• Total Ask Size: ${totalAskSize.toFixed(2)}\n\n`;

      responseText += `**Best Prices:**\n`;
      if (bestBid) {
        responseText += `• Best Bid: $${bestBid.price} (Size: ${bestBid.size})\n`;
      } else {
        responseText += `• Best Bid: No bids available\n`;
      }

      if (bestAsk) {
        responseText += `• Best Ask: $${bestAsk.price} (Size: ${bestAsk.size})\n`;
      } else {
        responseText += `• Best Ask: No asks available\n`;
      }

      responseText += `• Spread: ${spread === 'N/A' ? 'N/A' : '$' + spread}\n\n`;

      // Show top 5 bids and asks
      if (bidCount > 0) {
        responseText += `**Top 5 Bids:**\n`;
        orderBook.bids.slice(0, 5).forEach((bid, index) => {
          responseText += `${index + 1}. $${bid.price} - Size: ${bid.size}\n`;
        });
        responseText += `\n`;
      }

      if (askCount > 0) {
        responseText += `**Top 5 Asks:**\n`;
        orderBook.asks.slice(0, 5).forEach((ask, index) => {
          responseText += `${index + 1}. $${ask.price} - Size: ${ask.size}\n`;
        });
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ORDER_BOOK'],
        data: {
          orderBook,
          tokenId,
          summary: {
            bidCount,
            askCount,
            bestBid,
            bestAsk,
            spread,
            totalBidSize,
            totalAskSize,
          },
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return {
        text: responseText,
        values: {
          success: true,
          tokenId,
          bidCount,
          askCount,
          bestBidPrice: bestBid?.price,
          bestAskPrice: bestAsk?.price,
          spread,
          totalBidSize,
          totalAskSize,
        },
        data: {
          actionName: 'POLYMARKET_GET_ORDER_BOOK',
          orderBook,
          tokenId,
          summary: {
            bidCount,
            askCount,
            bestBid,
            bestAsk,
            spread,
            totalBidSize,
            totalAskSize,
          },
          timestamp: new Date().toISOString(),
        },
        success: true,
      };
    } catch (error) {
      logger.error('[getOrderBookSummaryAction] Error fetching order book:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred while fetching order book';
      const errorContent: Content = {
        text: `❌ **Error retrieving order book**: ${errorMessage}

Please check:
• The token ID is valid and exists
• CLOB_API_URL is correctly configured
• Network connectivity is available
• Polymarket CLOB service is operational

**Token ID**: \`${tokenId}\``,
        actions: ['POLYMARKET_GET_ORDER_BOOK'],
        data: {
          error: errorMessage,
          tokenId,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(errorContent);
      }
      return {
        text: errorContent.text,
        values: {
          success: false,
          error: true,
          tokenId,
        },
        data: {
          actionName: 'POLYMARKET_GET_ORDER_BOOK',
          error: errorMessage,
          tokenId,
          timestamp: new Date().toISOString(),
        },
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
      };
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me the order book for token 123456 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll retrieve the order book summary for that token from Polymarket.",
          action: 'POLYMARKET_GET_ORDER_BOOK',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Can I get the market depth for 789012 via Polymarket?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching the market depth and order book data for you from Polymarket...',
          action: 'POLYMARKET_GET_ORDER_BOOK',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'ORDER_BOOK 345678',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting order book data for token 345678 from Polymarket.',
          action: 'POLYMARKET_GET_ORDER_BOOK',
        },
      },
    ],
  ],
};
