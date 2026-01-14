/**
 * Research Market Action
 *
 * Initiates deep research on a Polymarket prediction market using OpenAI's
 * deep research capabilities. Research takes approximately 30 minutes.
 *
 * The action is asynchronous:
 * - If research exists and is valid: Returns cached results immediately
 * - If research is in progress: Returns status update
 * - If no research: Starts async research task and returns confirmation
 *
 * Use forceRefresh=true to start new research even if cached results exist.
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
import { ResearchStorageService } from "../services/researchStorage";
import { type MarketResearch, ResearchStatus } from "../types";
import { RESEARCH_TASK_NAME } from "../workers/researchTaskWorker";
import { researchMarketTemplate } from "../templates";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface ResearchParams {
  marketId?: string;
  marketQuestion?: string;
  forceRefresh?: boolean;
  callbackAction?: "EVALUATE_TRADE" | "NOTIFY_ONLY";
  error?: string;
}

/**
 * Build the research prompt for a market question
 */
function buildResearchPrompt(marketQuestion: string): string {
  return `Conduct comprehensive research on this prediction market question:

"${marketQuestion}"

Research goals:
1. Gather current state and the most recent developments related to this question
2. Find historical precedents and patterns that might inform the outcome
3. Collect expert opinions, forecasts, and analysis from multiple credible sources
4. Identify key factors and variables that could influence the result
5. Note any important upcoming events or deadlines
6. Assess the reliability and potential biases of different information sources

Provide a thorough, well-sourced analysis that would help someone make an informed prediction about this market's outcome.`;
}

/**
 * Format research results for display
 */
function formatResearchResults(research: MarketResearch): string {
  const rec = research.result?.recommendation;
  const recEmoji = rec?.shouldTrade
    ? rec.confidence > 80
      ? "🟢"
      : "🟡"
    : "🔴";

  let text = `📊 **Research Complete: ${research.marketQuestion}**\n\n`;

  if (research.result?.summary) {
    text += `**Summary:**\n${research.result.summary}\n\n`;
  }

  if (rec) {
    text += `**Trading Recommendation:** ${recEmoji}\n`;
    text += `• Should Trade: ${rec.shouldTrade ? "Yes" : "No"}\n`;
    if (rec.direction) {
      text += `• Direction: ${rec.direction}\n`;
    }
    text += `• Confidence: ${rec.confidence}%\n`;
    text += `• Reasoning: ${rec.reasoning}\n\n`;
  }

  if (research.result?.sourcesCount) {
    text += `**Sources Analyzed:** ${research.result.sourcesCount}\n`;
  }

  if (research.completedAt) {
    text += `**Completed:** ${new Date(research.completedAt).toLocaleString()}\n`;
  }

  if (research.expiresAt) {
    text += `**Expires:** ${new Date(research.expiresAt).toLocaleString()}\n`;
  }

  return text;
}

/**
 * Format the full research report (for detailed view)
 */
function formatFullReport(research: MarketResearch): string {
  let text = formatResearchResults(research);

  if (research.result?.text) {
    // Truncate if very long, but include substantial portion
    const reportText = research.result.text;
    const maxLength = 6000;

    if (reportText.length > maxLength) {
      text += `\n---\n\n**Full Report (truncated):**\n${reportText.substring(0, maxLength)}...\n\n[Report truncated for display]`;
    } else {
      text += `\n---\n\n**Full Report:**\n${reportText}`;
    }
  }

  if (research.result?.sources && research.result.sources.length > 0) {
    text += `\n\n**Sources:**\n`;
    research.result.sources.slice(0, 10).forEach((source, i) => {
      text += `${i + 1}. [${source.title}](${source.url})\n`;
    });
    if (research.result.sources.length > 10) {
      text += `... and ${research.result.sources.length - 10} more sources\n`;
    }
  }

  return text;
}

export const researchMarketAction: Action = {
  name: "POLYMARKET_RESEARCH_MARKET",
  similes: [
    "RESEARCH_MARKET",
    "ANALYZE_MARKET",
    "DEEP_RESEARCH",
    "INVESTIGATE_MARKET",
    "MARKET_RESEARCH",
    "RESEARCH_PREDICTION",
    "STUDY_MARKET",
    "GET_RESEARCH",
    "CHECK_RESEARCH",
  ],
  description: `Initiates or retrieves deep research on a Polymarket prediction market using OpenAI's deep research capabilities.

Research takes approximately 20-40 minutes to complete. The action handles three scenarios:
1. Research exists and is valid → Returns cached results immediately
2. Research is in progress → Returns status update with elapsed time
3. No research exists → Starts async research task and returns confirmation

Use forceRefresh=true to start new research even if cached results exist.
Parameters: marketId (condition_id), marketQuestion (the prediction question), forceRefresh (optional), callbackAction (optional: EVALUATE_TRADE or NOTIFY_ONLY)`,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const openaiKey = runtime.getSetting("OPENAI_API_KEY");
    if (!openaiKey) {
      runtime.logger.warn("[researchMarketAction] OPENAI_API_KEY required for research");
      return false;
    }

    const clobApiUrl = runtime.getSetting("CLOB_API_URL");
    if (!clobApiUrl) {
      runtime.logger.warn("[researchMarketAction] CLOB_API_URL required");
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const storage = new ResearchStorageService(runtime);

    // Parse parameters from LLM
    const llmResult = await callLLMWithTimeout<ResearchParams>(
      runtime,
      state,
      researchMarketTemplate,
      "researchMarketAction"
    );

    // Extract parameters from LLM result or options
    const marketId =
      llmResult && !isLLMError(llmResult)
        ? llmResult.marketId
        : (options?.marketId as string);
    const marketQuestion =
      llmResult && !isLLMError(llmResult)
        ? llmResult.marketQuestion
        : (options?.marketQuestion as string);
    const forceRefresh =
      (llmResult && !isLLMError(llmResult) ? llmResult.forceRefresh : false) ??
      (options?.forceRefresh as boolean) ??
      false;
    const callbackAction =
      (llmResult && !isLLMError(llmResult)
        ? llmResult.callbackAction
        : undefined) ??
      (options?.callbackAction as "EVALUATE_TRADE" | "NOTIFY_ONLY") ??
      "NOTIFY_ONLY";

    if (!marketId || !marketQuestion) {
      const errorText =
        "❌ **Missing Required Information**\n\n" +
        "To research a market, I need:\n" +
        "• **Market ID** (condition_id from Polymarket)\n" +
        "• **Market Question** (the prediction question)\n\n" +
        "Please provide the market details or use POLYMARKET_GET_MARKET_DETAILS first.";

      if (callback) {
        await callback({ text: errorText, actions: ["POLYMARKET_RESEARCH_MARKET"] });
      }

      return {
        success: false,
        text: errorText,
        data: { error: "missing_parameters" },
      };
    }

    // Check existing research status
    const existingResearch = await storage.getMarketResearch(marketId);

    // CASE 1: Research completed and not expired - return cached results
    if (
      existingResearch?.status === ResearchStatus.COMPLETED &&
      !forceRefresh
    ) {
      runtime.logger.info(
        `[researchMarketAction] Returning cached research for market: ${marketId}`
      );

      const responseText = formatResearchResults(existingResearch);
      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: true,
        text: responseText,
        data: {
          status: "completed",
          marketId,
          marketQuestion,
          recommendation: existingResearch.result?.recommendation,
          cached: true,
          completedAt: existingResearch.completedAt,
          expiresAt: existingResearch.expiresAt,
        },
      };
    }

    // CASE 2: Research in progress - return status
    if (existingResearch?.status === ResearchStatus.IN_PROGRESS) {
      const elapsedMinutes =
        (await storage.getResearchElapsedMinutes(marketId)) ?? 0;
      const estimatedRemaining = Math.max(30 - elapsedMinutes, 5);

      const responseText =
        `⏳ **Research In Progress**\n\n` +
        `**Market:** ${marketQuestion}\n` +
        `**Started:** ${elapsedMinutes} minutes ago\n` +
        `**Task ID:** \`${existingResearch.taskId}\`\n\n` +
        `Deep research typically takes 20-40 minutes. Estimated time remaining: ~${estimatedRemaining} minutes.\n\n` +
        `I'll have comprehensive analysis including:\n` +
        `• Key facts and recent developments\n` +
        `• Expert opinions and forecasts\n` +
        `• Trading recommendation with confidence level\n\n` +
        `You'll be notified when research completes.`;

      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: true,
        text: responseText,
        data: {
          status: "in_progress",
          marketId,
          marketQuestion,
          taskId: existingResearch.taskId,
          elapsedMinutes,
          estimatedRemaining,
        },
      };
    }

    // CASE 3: Research expired - inform and offer to refresh
    if (existingResearch?.status === ResearchStatus.EXPIRED && !forceRefresh) {
      const ageHours = existingResearch.completedAt
        ? Math.floor((Date.now() - existingResearch.completedAt) / 3600000)
        : 0;

      const responseText =
        `⚠️ **Research Expired**\n\n` +
        `Previous research for this market is ${ageHours} hours old and may be outdated.\n\n` +
        `**Previous Recommendation:** ${existingResearch.result?.recommendation?.shouldTrade ? "Trade" : "No Trade"} ` +
        `(${existingResearch.result?.recommendation?.confidence ?? 0}% confidence)\n\n` +
        `Would you like me to start fresh research? Use forceRefresh=true or ask me to "refresh the research".`;

      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: true,
        text: responseText,
        data: {
          status: "expired",
          marketId,
          marketQuestion,
          previousRecommendation: existingResearch.result?.recommendation,
          expiredAt: existingResearch.expiresAt,
        },
      };
    }

    // CASE 4: Research failed previously - inform and offer to retry
    if (existingResearch?.status === ResearchStatus.FAILED && !forceRefresh) {
      const responseText =
        `❌ **Previous Research Failed**\n\n` +
        `Error: ${existingResearch.errorMessage ?? "Unknown error"}\n\n` +
        `Would you like me to retry the research?`;

      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: false,
        text: responseText,
        data: {
          status: "failed",
          marketId,
          marketQuestion,
          error: existingResearch.errorMessage,
        },
      };
    }

    // CASE 5: No research or force refresh - start new research
    const researchPrompt = buildResearchPrompt(marketQuestion);

    runtime.logger.info(
      `[researchMarketAction] Starting new research for market: ${marketId}`
    );

    // Create the async task
    const taskId = await runtime.createTask({
      name: RESEARCH_TASK_NAME,
      description: `Deep research: ${marketQuestion.substring(0, 50)}...`,
      metadata: {
        marketId,
        marketQuestion,
        researchPrompt,
        callbackAction,
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
      tags: ["queue", "immediate"], // Execute immediately, one-time task
    });

    // Mark research as in progress
    await storage.markResearchInProgress(marketId, marketQuestion, taskId);

    const responseText =
      `🔬 **Research Started**\n\n` +
      `**Market:** ${marketQuestion}\n` +
      `**Task ID:** \`${taskId}\`\n\n` +
      `Deep research has been initiated. This typically takes 20-40 minutes.\n\n` +
      `I'll analyze hundreds of sources to provide:\n` +
      `• Current facts and recent developments\n` +
      `• Expert opinions and forecasts\n` +
      `• Historical precedents and patterns\n` +
      `• Trading recommendation with confidence level\n\n` +
      `You'll be notified when research completes. You can check status anytime by asking about this market's research.`;

    const content: Content = {
      text: responseText,
      actions: ["POLYMARKET_RESEARCH_MARKET"],
    };

    if (callback) {
      await callback(content);
    }

    return {
      success: true,
      text: responseText,
      data: {
        status: "started",
        marketId,
        marketQuestion,
        taskId,
        estimatedMinutes: 30,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Research the 'Will Bitcoin reach $100k by end of 2025?' market",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll start deep research on that prediction market. This will take about 30 minutes.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What's the research status for market 0x123abc?",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Let me check the research status for that market.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Do deep analysis on the Fed interest rate market before I trade",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll conduct comprehensive research on that market. Deep research takes 20-40 minutes but provides thorough analysis from hundreds of sources.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Refresh the research for the election market",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll start fresh research on that market, even if we have cached results.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
  ],
};

export default researchMarketAction;
