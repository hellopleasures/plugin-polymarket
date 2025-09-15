import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
  type ActionExample,
} from '@elizaos/core';

import { initializeClobClient } from '../utils/clobClient.js';
import { getSamplingMarketsTemplate } from '../templates.js';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';

// Trigger words and phrases for sampling markets action
const SAMPLING_MARKETS_SIMILES = [
  'SAMPLING_MARKETS',
  'GET_SAMPLING_MARKETS',
  'REWARD_MARKETS',
  'MARKETS_WITH_REWARDS',
  'INCENTIVE_MARKETS',
  'SAMPLING',
  'REWARDS_ENABLED',
  'LIQUIDITY_REWARDS',
  'MARKET_REWARDS',
  'EARNING_MARKETS',
  'INCENTIVIZED_MARKETS',
  'REWARD_ELIGIBLE',
  'BONUS_MARKETS',
  'EARN_REWARDS',
  'LIQUIDITY_MINING',
  'GET_REWARD_MARKETS',
  'SHOW_SAMPLING_MARKETS',
  'LIST_SAMPLING_MARKETS',
];

interface SamplingMarketsParams {
  next_cursor?: string;
  error?: string;
}

export const getSamplingMarkets: Action = {
  name: 'POLYMARKET_GET_SAMPLING_MARKETS',
  similes: SAMPLING_MARKETS_SIMILES.map((s) => `POLYMARKET_${s}`),
  description:
    'Get available Polymarket markets with rewards enabled (sampling markets) - markets where users can earn liquidity rewards',

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      logger.info('[getSamplingMarkets] Starting sampling markets retrieval');

      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Try to extract parameters using LLM
      let params: SamplingMarketsParams = {};
      try {
        const extractedParams = await callLLMWithTimeout<SamplingMarketsParams>(
          runtime,
          state,
          getSamplingMarketsTemplate,
          'getSamplingMarkets',
          30000
        );

        if (extractedParams && !extractedParams.error) {
          params = extractedParams;
        }
      } catch (error) {
        logger.warn('[getSamplingMarkets] LLM extraction failed, using defaults:', error);
        // Continue with empty params (no pagination cursor)
      }

      // Call CLOB API to get sampling markets
      logger.info('[getSamplingMarkets] Fetching sampling markets from CLOB API');
      const marketsResponse = await clobClient.getSamplingMarkets(params.next_cursor);

      const markets = marketsResponse.data || [];
      const totalCount = marketsResponse.count || 0;
      const nextCursor = marketsResponse.next_cursor;

      logger.info(`[getSamplingMarkets] Retrieved ${markets.length} sampling markets`);

      // Format response message
      const responseMessage = formatSamplingMarketsResponse(markets, totalCount, nextCursor);

      if (callback) {
        await callback({
          text: responseMessage,
          content: {
            action: 'POLYMARKET_SAMPLING_MARKETS_RETRIEVED',
            markets: markets,
            count: totalCount,
            next_cursor: nextCursor,
            timestamp: new Date().toISOString(),
          },
        });
      }

      return {
        text: responseMessage,
        values: {
          success: true,
          marketCount: markets.length,
          totalCount,
          hasMoreResults: !!nextCursor && nextCursor !== 'LTE=',
        },
        data: {
          actionName: 'POLYMARKET_GET_SAMPLING_MARKETS',
          markets: markets,
          count: totalCount,
          next_cursor: nextCursor,
          timestamp: new Date().toISOString(),
        },
        success: true,
      };
    } catch (error) {
      logger.error('[getSamplingMarkets] Error retrieving sampling markets:', error);

      const errorMessage = `❌ **Error getting sampling markets**: ${error instanceof Error ? error.message : 'Unknown error'}

Please check:
• CLOB_API_URL is correctly configured
• Network connectivity is available
• API service is operational`;

      if (callback) {
        await callback({
          text: errorMessage,
          content: {
            action: 'POLYMARKET_SAMPLING_MARKETS_ERROR',
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          },
        });
      }

      return {
        text: errorMessage,
        values: {
          success: false,
          error: true,
        },
        data: {
          actionName: 'POLYMARKET_GET_SAMPLING_MARKETS',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        },
        success: false,
        error: error instanceof Error ? error : new Error('Unknown error'),
      };
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me markets with rewards enabled via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '📊 **Sampling Markets (Rewards Enabled)**\n\nFound 15 markets with liquidity rewards:\n\n🏆 **Will Donald Trump win the 2024 election?**\n├─ Category: Politics\n├─ Active: ✅\n├─ Tokens: Yes (0.67) | No (0.33)\n└─ Rewards: Min $10, Max 2% spread\n\n🏆 **Will Bitcoin reach $100k by end of 2024?**\n├─ Category: Crypto\n├─ Active: ✅\n├─ Tokens: Yes (0.45) | No (0.55)\n└─ Rewards: Min $5, Max 1.5% spread\n\n🏆 **Will Lakers make NBA playoffs?**\n├─ Category: Sports\n├─ Active: ✅\n├─ Tokens: Yes (0.78) | No (0.22)\n└─ Rewards: Min $25, Max 3% spread\n\n📈 **Total**: 15 markets • **Next**: Use cursor LTE= for more',
          action: 'POLYMARKET_SAMPLING_MARKETS_RETRIEVED',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get sampling markets for rewards via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '🎁 **Sampling Markets Overview**\n\nShowing markets with liquidity mining rewards:\n\n💰 **Active Reward Markets**: 8\n📊 **Categories**: Politics (3), Sports (2), Crypto (2), Other (1)\n🕒 **Last Updated**: 2024-01-15T10:30:00Z\n\n**Top Reward Opportunities:**\n• Politics markets: Up to 5% APY\n• Sports events: 2-4% rewards\n• Crypto predictions: 3-6% yields\n\n💡 **Tip**: Higher volume markets typically offer better reward rates!',
          action: 'POLYMARKET_SAMPLING_MARKETS_RETRIEVED',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'SAMPLING_MARKETS with cursor ABC123 via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '📄 **Sampling Markets (Page 2)**\n\nContinuing from cursor ABC123...\n\n🏆 **Will Fed cut rates in March?**\n├─ Category: Economics\n├─ Tokens: Yes/No\n└─ Rewards: Active\n\n🏆 **Super Bowl winner prediction**\n├─ Category: Sports\n├─ Tokens: Team outcomes\n└─ Rewards: 2.5% max spread\n\n📊 **Page Info**: 2 more markets • **Next**: DEF456\n\n🔄 Use "get sampling markets with cursor DEF456" for next page',
          action: 'POLYMARKET_SAMPLING_MARKETS_RETRIEVED',
        },
      },
    ],
  ] satisfies ActionExample[][],
};

/**
 * Format sampling markets response for display
 */
function formatSamplingMarketsResponse(
  markets: any[],
  totalCount: number,
  nextCursor?: string
): string {
  if (markets.length === 0) {
    return '📊 **No sampling markets found**\n\nThere are currently no markets with rewards enabled. Check back later for new reward opportunities!';
  }

  let response = `🎁 **Sampling Markets (Rewards Enabled)**\n\nFound ${markets.length} markets with liquidity rewards:\n\n`;

  // Show first few markets with details
  const displayMarkets = markets.slice(0, 5);

  for (const market of displayMarkets) {
    const tokens = market.tokens || [];
    const rewards = market.rewards || {};

    response += `🏆 **${market.question || 'Unknown Market'}**\n`;
    response += `├─ Category: ${market.category || 'N/A'}\n`;
    response += `├─ Active: ${market.active ? '✅' : '❌'}\n`;

    if (tokens.length >= 2) {
      response += `├─ Tokens: ${tokens[0]?.outcome || 'Yes'} | ${tokens[1]?.outcome || 'No'}\n`;
    }

    // Show reward info if available
    if (rewards.min_size || rewards.max_spread) {
      const minSize = rewards.min_size ? `Min $${rewards.min_size}` : '';
      const maxSpread = rewards.max_spread ? `Max ${rewards.max_spread}% spread` : '';
      const rewardInfo = [minSize, maxSpread].filter(Boolean).join(', ');
      response += `└─ Rewards: ${rewardInfo}\n`;
    } else {
      response += `└─ Rewards: Enabled\n`;
    }

    response += '\n';
  }

  if (markets.length > 5) {
    response += `... and ${markets.length - 5} more markets\n\n`;
  }

  // Add pagination info
  if (nextCursor && nextCursor !== 'LTE=') {
    response += `📄 **Total**: ${totalCount} markets • **Next**: Use cursor ${nextCursor} for more`;
  } else {
    response += `📈 **Total**: ${totalCount} markets • **End of results**`;
  }

  return response;
}
