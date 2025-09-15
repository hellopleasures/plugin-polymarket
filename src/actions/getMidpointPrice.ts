import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClient } from '../utils/clobClient';
import { getMidpointPriceTemplate } from '../templates';

interface MidpointPriceParams {
  tokenId: string;
}

/**
 * Get midpoint price for a market token action for Polymarket
 * Fetches the midpoint price (halfway between best bid and best ask) for a specific token
 */
export const getMidpointPriceAction: Action = {
  name: 'POLYMARKET_GET_MIDPOINT_PRICE',
  similes: [
    'MIDPOINT_PRICE',
    'GET_MIDPOINT',
    'SHOW_MIDPOINT',
    'FETCH_MIDPOINT',
    'MIDPOINT_DATA',
    'MARKET_MIDPOINT',
    'MID_PRICE',
    'MIDDLE_PRICE',
    'GET_MID_PRICE',
    'SHOW_MID_PRICE',
    'FETCH_MID_PRICE',
    'MIDPOINT_CHECK',
    'CHECK_MIDPOINT',
    'MIDPOINT_LOOKUP',
    'TOKEN_MIDPOINT',
    'MARKET_MID',
  ],
  description:
    'Get the midpoint price (halfway between best bid and best ask) for a specific market token',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getMidpointPriceAction] Validate called for message: "${message.content?.text}"`);

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getMidpointPriceAction] CLOB_API_URL is required but not provided');
      return false;
    }

    logger.info('[getMidpointPriceAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info('[getMidpointPriceAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getMidpointPriceAction] Configuration error: ${errorMessage}`);
      const errorResult: ActionResult = {
        text: errorMessage,
        values: {
          success: false,
          error: true,
        },
        data: {
          actionName: 'POLYMARKET_GET_MIDPOINT_PRICE',
          error: errorMessage,
        },
        success: false,
        error: new Error(errorMessage),
      };

      if (callback) {
        await callback({ text: errorResult.text, data: errorResult.data });
      }
      return errorResult;
    }

    let tokenId: string;

    try {
      // Use LLM to extract parameters
      const llmResult = await callLLMWithTimeout<{ tokenId?: string; error?: string }>(
        runtime,
        state,
        getMidpointPriceTemplate,
        'getMidpointPriceAction'
      );

      logger.info('[getMidpointPriceAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error) {
        throw new Error('Token ID not found');
      }

      tokenId = llmResult?.tokenId || '';

      if (!tokenId) {
        throw new Error('Token ID not found');
      }
    } catch (error) {
      logger.warn('[getMidpointPriceAction] LLM extraction failed, trying regex fallback');

      // Fallback to regex extraction
      const text = message.content?.text || '';

      // Extract token ID - look for patterns like "token 123456", "market 456789", or just numbers
      const tokenMatch = text.match(/(?:token|market|id)\s+([a-zA-Z0-9]+)|([0-9]{5,})/i);
      tokenId = tokenMatch?.[1] || tokenMatch?.[2] || '';

      if (!tokenId) {
        const errorMessage = 'Please provide a token ID to get the midpoint price for.';
        logger.error(`[getMidpointPriceAction] Token ID extraction failed`);

        const errorResult: ActionResult = {
          text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. Examples:
• "Get midpoint price for token 123456"
• "What's the midpoint for market token 789012?"
• "Show me the mid price for 456789"`,
          values: {
            success: false,
            error: true,
          },
          data: {
            actionName: 'POLYMARKET_GET_MIDPOINT_PRICE',
            error: errorMessage,
          },
          success: false,
          error: new Error(errorMessage),
        };

        if (callback) {
          await callback({ text: errorResult.text, data: errorResult.data });
        }
        return errorResult;
      }
    }

    try {
      const client = await initializeClobClient(runtime);
      const midpointResponse = await client.getMidpoint(tokenId);

      if (!midpointResponse || !midpointResponse.mid) {
        throw new Error(`No midpoint price data available for token ${tokenId}`);
      }

      const midpointValue = parseFloat(midpointResponse.mid);
      const formattedPrice = midpointValue.toFixed(4);
      const percentagePrice = (midpointValue * 100).toFixed(2);

      const responseText = `🎯 **Midpoint Price for Token ${tokenId}**

**Midpoint Price**: $${formattedPrice} (${percentagePrice}%)
**Token ID**: ${tokenId}

The midpoint price represents the halfway point between the best bid and best ask prices, providing a fair market value estimate for this prediction market token.`;

      const responseResult: ActionResult = {
        text: responseText,
        values: {
          success: true,
          tokenId,
          midpoint: midpointResponse.mid,
          formattedPrice,
          percentagePrice,
        },
        data: {
          actionName: 'POLYMARKET_GET_MIDPOINT_PRICE',
          tokenId,
          midpoint: midpointResponse.mid,
          formattedPrice,
          percentagePrice,
          timestamp: new Date().toISOString(),
        },
        success: true,
      };

      if (callback) {
        await callback({ text: responseResult.text, data: responseResult.data });
      }

      return responseResult;
    } catch (error) {
      logger.error('[getMidpointPriceAction] Error fetching midpoint price:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      const errorResult: ActionResult = {
        text: `❌ **Error getting midpoint price**: ${errorMessage}

Please check:
• The token ID is valid and exists
• CLOB_API_URL is correctly configured
• Network connectivity is available

**Token ID**: \`${tokenId}\``,
        values: {
          success: false,
          error: true,
        },
        data: {
          actionName: 'POLYMARKET_GET_MIDPOINT_PRICE',
          error: errorMessage,
          tokenId,
          timestamp: new Date().toISOString(),
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };

      if (callback) {
        await callback({ text: errorResult.text, data: errorResult.data });
      }
      return errorResult;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get midpoint price for token 123456 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the midpoint price for that token via Polymarket.",
          action: 'POLYMARKET_GET_MIDPOINT_PRICE',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "What's the midpoint for market token 789012 via Polymarket?",
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the midpoint price for that market token via Polymarket.',
          action: 'POLYMARKET_GET_MIDPOINT_PRICE',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me the mid price for 456789 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the midpoint price for token 456789 via Polymarket.',
          action: 'POLYMARKET_GET_MIDPOINT_PRICE',
        },
      },
    ],
  ],
};
