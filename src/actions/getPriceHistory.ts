import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
  type ActionExample,
} from '@elizaos/core';

import { initializeClobClient } from '../utils/clobClient.js';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';

export interface PricePoint {
  t: number;
  p: number;
}

export enum PriceHistoryInterval {
  '1m' = '1m',
  '5m' = '5m',
  '1h' = '1h',
  '1d' = '1d',
  '1w' = '1w',
}

// Trigger words and phrases for price history action
const PRICE_HISTORY_SIMILES = [
  'PRICE_HISTORY',
  'GET_PRICE_HISTORY',
  'PRICES_HISTORY',
  'HISTORICAL_PRICES',
  'PRICE_CHART',
  'PRICE_DATA',
  'CHART_DATA',
  'HISTORICAL_DATA',
  'TIME_SERIES',
  'PRICE_TIMELINE',
  'MARKET_HISTORY',
  'TOKEN_HISTORY',
  'PRICE_TREND',
  'HISTORICAL_CHART',
  'SHOW_PRICE_HISTORY',
  'FETCH_PRICE_HISTORY',
  'GET_HISTORICAL_PRICES',
  'SHOW_HISTORICAL_PRICES',
];

interface PriceHistoryParams {
  tokenId?: string;
  interval?: string;
  error?: string;
}

// Template for LLM parameter extraction
const priceHistoryTemplate = `
Extract the token ID and interval from the user's message for getting price history.

User message: "{{message}}"

Please extract:
- tokenId: The token identifier (numeric string)
- interval: Time interval (e.g., "1m", "5m", "1h", "1d", "1w"). Default to "1d" if not specified.

Return a JSON object with the extracted parameters. If you cannot find a tokenId, set error field.

Example response:
{
  "tokenId": "123456789",
  "interval": "1d"
}

If tokenId is missing:
{
  "error": "Token ID is required for price history"
}
`;

export const getPriceHistory: Action = {
  name: 'POLYMARKET_GET_PRICE_HISTORY',
  similes: PRICE_HISTORY_SIMILES.map((s) => `POLYMARKET_${s}`),
  description:
    'Get historical price data for a Polymarket token - returns time-series of price points with timestamps and prices',

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      logger.info('[getPriceHistory] Starting price history retrieval');

      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Extract parameters using LLM
      let params: PriceHistoryParams = {};
      try {
        const extractedParams = await callLLMWithTimeout<PriceHistoryParams>(
          runtime,
          state,
          priceHistoryTemplate.replace('{{message}}', message.content.text || ''),
          'getPriceHistory',
          30000
        );

        if (extractedParams && !extractedParams.error) {
          params = extractedParams;
        } else if (extractedParams?.error) {
          throw new Error(extractedParams.error);
        }
      } catch (error) {
        logger.error('[getPriceHistory] LLM extraction failed:', error);
        throw new Error('Failed to extract token ID from message. Please specify a token ID.');
      }

      // Validate required parameters
      if (!params.tokenId) {
        throw new Error('Token ID is required for price history retrieval');
      }

      // Set default interval if not provided
      const interval = params.interval || '1d';

      // Call CLOB API to get price history
      logger.info(
        `[getPriceHistory] Fetching price history for token ${params.tokenId} with interval ${interval}`
      );
      const priceHistory = await (clobClient as any).getPricesHistory({
        token_id: params.tokenId,
        interval: interval as any,
      });

      logger.info(`[getPriceHistory] Retrieved ${priceHistory?.length || 0} price points`);

      // Format response message (handle null/undefined)
      const responseMessage = formatPriceHistoryResponse(
        priceHistory || [],
        params.tokenId,
        interval
      );

      if (callback) {
        await callback({
          text: responseMessage,
          content: {
            action: 'POLYMARKET_PRICE_HISTORY_RETRIEVED',
            tokenId: params.tokenId,
            interval: interval,
            priceHistory: priceHistory,
            pointsCount: priceHistory?.length || 0,
            timestamp: new Date().toISOString(),
          },
        });
      }

      return;
    } catch (error) {
      logger.error('[getPriceHistory] Error retrieving price history:', error);

      const errorMessage = `❌ **Error getting price history**: ${error instanceof Error ? error.message : 'Unknown error'}

Please check:
• Token ID is valid and exists
• Interval format is correct (e.g., "1m", "1h", "1d")
• CLOB_API_URL is correctly configured
• Network connectivity is available`;

      if (callback) {
        await callback({
          text: errorMessage,
          content: {
            action: 'POLYMARKET_PRICE_HISTORY_ERROR',
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          },
        });
      }

      return;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Get price history for token 123456 with 1d interval via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '📈 **Price History for Token 123456**\n\n⏱️ **Interval**: 1d\n📊 **Data Points**: 30\n\n**Recent Price Points:**\n• 2024-01-15 12:00:00 - $0.6523 (65.23%)\n• 2024-01-14 12:00:00 - $0.6445 (64.45%)\n• 2024-01-13 12:00:00 - $0.6387 (63.87%)\n• 2024-01-12 12:00:00 - $0.6234 (62.34%)\n• 2024-01-11 12:00:00 - $0.6156 (61.56%)\n\n📈 **Price Trend**: +2.78% over the period\n💹 **Highest**: $0.6789 (67.89%)\n📉 **Lowest**: $0.5923 (59.23%)\n\n🕒 **Time Range**: Jan 15, 2024 - Dec 16, 2023',
          action: 'POLYMARKET_PRICE_HISTORY_RETRIEVED',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'PRICE_HISTORY 789012 via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '📊 **Historical Prices for Token 789012**\n\n⏱️ **Interval**: 1d (default)\n📈 **Retrieved**: 25 price points\n\n**Price Summary:**\n• Current: $0.4523 (45.23%)\n• 24h ago: $0.4456 (44.56%)\n• 7d ago: $0.4234 (42.34%)\n• Change: +2.89% (24h) | +6.83% (7d)\n\n📊 **Complete time-series data available in response**',
          action: 'POLYMARKET_PRICE_HISTORY_RETRIEVED',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me 1h price chart for token 456789 via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '⚡ **Hourly Price History - Token 456789**\n\n⏱️ **Interval**: 1h\n📊 **Data Points**: 48 (last 48 hours)\n\n**Recent Hourly Prices:**\n• 15:00 - $0.7234 (72.34%)\n• 14:00 - $0.7189 (71.89%)\n• 13:00 - $0.7156 (71.56%)\n• 12:00 - $0.7123 (71.23%)\n• 11:00 - $0.7098 (70.98%)\n\n📈 **Hourly Trend**: +1.36% over 48h\n🎯 **Volatility**: Moderate\n📊 **Trading Activity**: Active',
          action: 'POLYMARKET_PRICE_HISTORY_RETRIEVED',
        },
      },
    ],
  ] satisfies ActionExample[][],
};

/**
 * Format price history response for display
 */
function formatPriceHistoryResponse(
  priceHistory: PricePoint[],
  tokenId: string,
  interval: string
): string {
  if (priceHistory.length === 0) {
    return `📈 **No price history found for Token ${tokenId}**\n\nNo historical price data is available for this token. This might be due to:\n• Token being newly created\n• Insufficient trading activity\n• Invalid token ID\n\nPlease verify the token ID and try again.`;
  }

  let response = `📈 **Price History for Token ${tokenId}**\n\n`;
  response += `⏱️ **Interval**: ${interval}\n`;
  response += `📊 **Data Points**: ${priceHistory.length}\n\n`;

  // Sort by timestamp (most recent first)
  const sortedHistory = [...priceHistory].sort((a, b) => b.t - a.t);

  // Show recent price points (first 5)
  const recentPoints = sortedHistory.slice(0, 5);
  response += `**Recent Price Points:**\n`;

  for (const point of recentPoints) {
    const date = new Date(point.t * 1000);
    const formattedDate =
      date.toISOString().split('T')[0] + ' ' + date.toTimeString().split(' ')[0];
    const price = point.p;
    const percentage = (price * 100).toFixed(2);
    response += `• ${formattedDate} - $${price.toFixed(4)} (${percentage}%)\n`;
  }

  // Calculate price trend
  if (sortedHistory.length >= 2) {
    const latestPrice = sortedHistory[0].p;
    const earliestPrice = sortedHistory[sortedHistory.length - 1].p;
    const priceChange = ((latestPrice - earliestPrice) / earliestPrice) * 100;
    const trendIcon = priceChange >= 0 ? '📈' : '📉';
    response += `\n${trendIcon} **Price Trend**: ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}% over the period\n`;
  }

  // Calculate high and low
  const prices = priceHistory.map((p) => p.p);
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  response += `💹 **Highest**: $${highest.toFixed(4)} (${(highest * 100).toFixed(2)}%)\n`;
  response += `📉 **Lowest**: $${lowest.toFixed(4)} (${(lowest * 100).toFixed(2)}%)\n`;

  // Add time range
  if (sortedHistory.length >= 2) {
    const latestDate = new Date(sortedHistory[0].t * 1000);
    const earliestDate = new Date(sortedHistory[sortedHistory.length - 1].t * 1000);
    const latestFormatted = latestDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const earliestFormatted = earliestDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    response += `\n🕒 **Time Range**: ${latestFormatted} - ${earliestFormatted}`;
  }

  return response;
}
