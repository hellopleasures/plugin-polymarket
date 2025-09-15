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
import { retrieveAllMarketsTemplate } from '../templates';
import type { MarketFilters, Market } from '../types';

/**
 * Retrieve all available markets action for Polymarket
 * Fetches the complete list of prediction markets from the CLOB
 */
export const retrieveAllMarketsAction: Action = {
  name: 'POLYMARKET_GET_ALL_MARKETS',
  similes: [
    'LIST_MARKETS',
    'SHOW_MARKETS',
    'GET_MARKETS',
    'FETCH_MARKETS',
    'ALL_MARKETS',
    'AVAILABLE_MARKETS',
  ],
  description: 'Retrieve all available prediction markets from Polymarket',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[retrieveAllMarketsAction] CLOB_API_URL is required but not provided');
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
    logger.info('[retrieveAllMarketsAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[retrieveAllMarketsAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYMARKET_GET_ALL_MARKETS'],
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
          actionName: 'POLYMARKET_GET_ALL_MARKETS',
          error: errorMessage,
        },
        success: false,
        error: new Error(errorMessage),
      };
    }

    let filterParams: MarketFilters = {};

    // Extract optional filter parameters using LLM
    try {
      const llmResult = await callLLMWithTimeout<MarketFilters & { error?: string }>(
        runtime,
        state,
        retrieveAllMarketsTemplate,
        'retrieveAllMarketsAction'
      );

      if (llmResult?.error) {
        logger.info(
          '[retrieveAllMarketsAction] No specific filters requested, fetching all markets'
        );
        filterParams = {};
      } else {
        filterParams = {
          category: llmResult?.category,
          active: llmResult?.active,
          limit: llmResult?.limit,
        };
      }
    } catch (error) {
      logger.debug(
        '[retrieveAllMarketsAction] LLM parameter extraction failed, using defaults:',
        error
      );
      filterParams = {};
    }

    try {
      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Fetch markets with optional pagination and filters
      const response = await (clobClient as any).getMarkets(
        filterParams?.next_cursor || '',
        filterParams
      );

      if (!response || !response.data) {
        throw new Error('Invalid response from CLOB API');
      }

      const markets: Market[] = response.data;
      const marketCount = markets.length;

      // Format response text
      let responseText = `📊 **Retrieved ${marketCount} Polymarket prediction markets**\n\n`;

      if (marketCount === 0) {
        responseText += 'No markets found matching your criteria.';
      } else {
        // Show first few markets as preview
        const previewMarkets = markets.slice(0, 5);
        responseText += '**Sample Markets:**\n';

        previewMarkets.forEach((market: Market, index: number) => {
          responseText += `${index + 1}. **${market.question}**\n`;
          responseText += `   • Category: ${market.category || 'N/A'}\n`;
          responseText += `   • Active: ${market.active ? '✅' : '❌'}\n`;
          responseText += `   • End Date: ${market.end_date_iso ? new Date(market.end_date_iso).toLocaleDateString() : 'N/A'}\n\n`;
        });

        if (marketCount > 5) {
          responseText += `... and ${marketCount - 5} more markets\n\n`;
        }

        responseText += `**Summary:**\n`;
        responseText += `• Total Markets: ${marketCount}\n`;
        responseText += `• Data includes: question, category, tokens, rewards, and trading details\n`;

        if (response.next_cursor && response.next_cursor !== 'LTE=') {
          responseText += `• More results available (paginated)\n`;
        }
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ALL_MARKETS'],
        data: {
          markets,
          count: marketCount,
          total: response.count || marketCount,
          next_cursor: response.next_cursor,
          limit: response.limit,
          filters: filterParams,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return {
        text: responseText,
        values: {
          success: true,
          marketCount,
          totalCount: response.count || marketCount,
          hasMoreResults: !!response.next_cursor && response.next_cursor !== 'LTE=',
        },
        data: {
          actionName: 'POLYMARKET_GET_ALL_MARKETS',
          markets,
          count: marketCount,
          total: response.count || marketCount,
          next_cursor: response.next_cursor,
          limit: response.limit,
          filters: filterParams,
        },
        success: true,
      };
    } catch (error) {
      logger.error('[retrieveAllMarketsAction] Error fetching markets:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred while fetching markets';
      const errorContent: Content = {
        text: `❌ **Error retrieving markets**: ${errorMessage}

Please check:
• CLOB_API_URL is correctly configured
• Network connectivity is available
• Polymarket CLOB service is operational`,
        actions: ['POLYMARKET_GET_ALL_MARKETS'],
        data: {
          error: errorMessage,
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
        },
        data: {
          actionName: 'POLYMARKET_GET_ALL_MARKETS',
          error: errorMessage,
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
          text: 'Show me all available prediction markets via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll retrieve all available Polymarket prediction markets for you.",
          action: 'POLYMARKET_GET_ALL_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What markets can I trade on Polymarket?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me fetch the current list of available markets from Polymarket.',
          action: 'POLYMARKET_GET_ALL_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'List all active prediction markets via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get all the active prediction markets currently available via Polymarket.",
          action: 'POLYMARKET_GET_ALL_MARKETS',
        },
      },
    ],
  ],
};
