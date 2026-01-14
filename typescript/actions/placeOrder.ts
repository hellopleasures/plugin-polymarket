import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  type ClobClient,
  OrderType as ClobOrderType,
  Side,
  type UserOrder,
} from "@polymarket/clob-client";
import { POLYMARKET_PROVIDER_CACHE_KEY } from "../constants";
import { orderTemplate } from "../templates";
import type { OrderResponse } from "../types";
import { initializeClobClientWithCreds } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface PlaceOrderParams {
  tokenId: string;
  side: string;
  price: number;
  size: number;
  orderType?: string;
  feeRateBps?: string;
  marketName?: string;
  error?: string;
}

export const placeOrderAction: Action = {
  name: "POLYMARKET_PLACE_ORDER",
  similes: [
    "PLACE_ORDER",
    "CREATE_ORDER",
    "BUY_TOKEN",
    "SELL_TOKEN",
    "LIMIT_ORDER",
    "MARKET_ORDER",
    "TRADE",
    "ORDER",
    "BUY",
    "SELL",
    "PURCHASE",
    "SUBMIT_ORDER",
    "EXECUTE_ORDER",
  ],
  description:
    "Creates and submits a buy/sell order on Polymarket. Use when the user explicitly wants to trade and provides token ID, side, price, and size (or enough detail to infer them). Do not use for price lookups or order status checks; use POLYMARKET_GET_ORDER_BOOK for best-price lookups or getOrderDetailsAction for status checks. Parameters: tokenId, side (BUY/SELL), price (decimal or percent), size, orderType (GTC/GTD/FOK/FAK), feeRateBps (optional). Requires full CLOB credentials.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const privateKey =
      runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
      runtime.getSetting("EVM_PRIVATE_KEY") ||
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY");

    if (!privateKey) {
      runtime.logger.warn("[placeOrderAction] Private key is required for trading");
      return false;
    }

    // Credentials can come from env OR be derived/created at runtime
    const clobApiKey = runtime.getSetting("CLOB_API_KEY");
    const clobApiSecret = runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
    const clobApiPassphrase =
      runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");
    const allowCreate = runtime.getSetting("POLYMARKET_ALLOW_CREATE_API_KEY");
    const hasEnvCreds = Boolean(clobApiKey && clobApiSecret && clobApiPassphrase);
    const canCreateCreds = allowCreate !== "false" && allowCreate !== false;

    if (!hasEnvCreds && !canCreateCreds) {
      runtime.logger.warn(
        "[placeOrderAction] CLOB API credentials are required for trading. " +
          "Set CLOB_API_KEY/SECRET/PASSPHRASE or enable POLYMARKET_ALLOW_CREATE_API_KEY."
      );
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, string | number | boolean>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const llmResult = await callLLMWithTimeout<PlaceOrderParams>(
      runtime,
      state,
      orderTemplate,
      "placeOrderAction"
    );

    if (isLLMError(llmResult)) {
      throw new Error("Required order parameters not found");
    }

    const tokenId = llmResult?.tokenId ?? "";
    let side = llmResult?.side?.toUpperCase() ?? "BUY";
    let price = llmResult?.price ?? 0;
    const size = llmResult?.size ?? 0;
    let orderType = llmResult?.orderType?.toUpperCase() ?? "GTC";
    const feeRateBps = llmResult?.feeRateBps ?? "0";
    if (tokenId === "MARKET_NAME_LOOKUP" && llmResult?.marketName) {
      throw new Error(
        `Market name lookup not yet implemented. Please provide a specific token ID. You requested: "${llmResult.marketName}"`
      );
    }

    if (!tokenId || price <= 0 || size <= 0) {
      throw new Error("Invalid order parameters: tokenId, price, and size are required");
    }

    if (!["BUY", "SELL"].includes(side)) {
      side = "BUY";
    }

    if (price > 1.0) {
      price = price / 100; // Convert percentage to decimal
    }

    if (!["GTC", "FOK", "GTD", "FAK"].includes(orderType)) {
      orderType = "GTC";
    }

    const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;

    const orderArgs: UserOrder = {
      tokenID: tokenId,
      price,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      size,
      feeRateBps: parseFloat(feeRateBps),
    };

    let orderResponse: OrderResponse;

    if (orderType === "FOK" || orderType === "FAK") {
      const marketOrderType = orderType === "FAK" ? ClobOrderType.FAK : ClobOrderType.FOK;
      const marketOrderArgs = {
        tokenID: tokenId,
        price,
        amount: size,
        side: side === "BUY" ? Side.BUY : Side.SELL,
        feeRateBps: parseFloat(feeRateBps),
        orderType: marketOrderType as ClobOrderType.FOK | ClobOrderType.FAK,
      };
      orderResponse = (await client.createAndPostMarketOrder(marketOrderArgs)) as OrderResponse;
    } else {
      const clobOrderType = orderType === "GTD" ? ClobOrderType.GTD : ClobOrderType.GTC;
      orderResponse = (await client.createAndPostOrder(
        orderArgs,
        undefined,
        clobOrderType
      )) as OrderResponse;
    }

    let responseText: string;

    if (orderResponse.success) {
      await runtime.deleteCache(POLYMARKET_PROVIDER_CACHE_KEY);
      const sideText = side.toLowerCase();
      const orderTypeText =
        orderType === "GTC" ? "limit" : orderType === "FOK" ? "market" : orderType.toLowerCase();
      const totalValue = (price * size).toFixed(4);

      responseText =
        `✅ **Order Placed Successfully**\n\n` +
        `**Order Details:**\n` +
        `• Type: ${orderTypeText} ${sideText} order\n` +
        `• Token ID: \`${tokenId}\`\n` +
        `• Side: ${side}\n` +
        `• Price: $${price.toFixed(4)} (${(price * 100).toFixed(2)}%)\n` +
        `• Size: ${size} shares\n` +
        `• Total Value: $${totalValue}\n\n` +
        `**Order Response:**\n` +
        `• Order ID: ${orderResponse.orderId ?? "Pending"}\n` +
        `• Status: ${orderResponse.status ?? "submitted"}`;

      if (orderResponse.orderHashes?.length) {
        responseText += `\n• Transaction Hash(es): ${orderResponse.orderHashes.join(", ")}`;
      }

      if (orderResponse.status === "matched") {
        responseText += "\n\n🎉 Your order was immediately matched!";
      } else if (orderResponse.status === "delayed") {
        responseText += "\n\n⏳ Your order is subject to a matching delay.";
      }

    } else {
      responseText =
        `❌ **Order Placement Failed**\n\n` +
        `**Error**: ${orderResponse.errorMsg ?? "Unknown error"}\n\n` +
        `**Order Details Attempted:**\n` +
        `• Token ID: ${tokenId}\n` +
        `• Side: ${side}\n` +
        `• Price: $${price.toFixed(4)}\n` +
        `• Size: ${size} shares`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_PLACE_ORDER"],
    };

    if (callback) {
      await callback(responseContent);
    }

    return {
      success: orderResponse.success ?? false,
      text: responseText,
      data: {
        orderId: orderResponse.orderId ?? "",
        status: orderResponse.status ?? "",
        tokenId,
        side,
        price: String(price),
        size: String(size),
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Buy 100 shares of token 123456 at $0.50 as a limit order",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll place a limit buy order for you on Polymarket.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Place a market sell order for 50 tokens of 789012",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll place a market sell order for you.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What is the best ask for token 789012?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That’s a pricing question, not an order placement. I can fetch the best price from the order book instead.",
        },
      },
    ],
  ],
};
