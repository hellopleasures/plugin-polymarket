//! Dedicated positions action module for Polymarket.
//!
//! Builds a position snapshot from trade history, calculating realised and
//! unrealised PnL per asset.  Mirrors the Python `positions.py` module.

use std::collections::HashMap;

use crate::client::ClobClient;
use crate::error::{PolymarketError, Result};
use crate::types::{OrderSide, Position};
use serde::{Deserialize, Serialize};

// =============================================================================
// Types
// =============================================================================

/// Configuration for a positions query.
#[derive(Debug, Clone)]
pub struct PositionsQueryParams {
    /// Maximum number of trades to scan.
    pub limit: u32,
    /// Maximum trade-history pages to fetch.
    pub max_pages: u32,
    /// Optional asset IDs to filter positions for.
    pub asset_ids: Option<Vec<String>>,
    /// Fetch order-book mid-prices for unrealised PnL.
    pub include_prices: bool,
    /// Max assets to look up prices for.
    pub price_lookup_limit: usize,
}

impl Default for PositionsQueryParams {
    fn default() -> Self {
        Self {
            limit: 500,
            max_pages: 10,
            asset_ids: None,
            include_prices: true,
            price_lookup_limit: 10,
        }
    }
}

/// Internal accumulator used while rebuilding positions from trades.
#[derive(Debug)]
struct PositionAccumulator {
    market: String,
    asset_id: String,
    size: f64,
    average_price: f64,
    realized_pnl: f64,
}

/// Summary of a positions query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionsSummary {
    /// Individual positions.
    pub positions: Vec<Position>,
    /// Number of trades scanned.
    pub trades_scanned: usize,
    /// Total realised PnL across all positions.
    pub total_realized_pnl: f64,
    /// Total unrealised PnL across all positions.
    pub total_unrealized_pnl: f64,
}

// =============================================================================
// Helpers
// =============================================================================

fn safe_parse(value: &str) -> f64 {
    value.parse::<f64>().unwrap_or(0.0)
}

fn update_position_for_trade(pos: &mut PositionAccumulator, side: &OrderSide, price: f64, qty: f64) {
    if qty <= 0.0 || price <= 0.0 {
        return;
    }

    match side {
        OrderSide::Buy => {
            if pos.size >= 0.0 {
                let new_size = pos.size + qty;
                pos.average_price = if new_size == 0.0 {
                    0.0
                } else {
                    (pos.average_price * pos.size + price * qty) / new_size
                };
                pos.size = new_size;
            } else {
                let short_size = pos.size.abs();
                let close_size = short_size.min(qty);
                pos.realized_pnl += (pos.average_price - price) * close_size;
                let remaining = qty - close_size;
                if remaining > 0.0 {
                    pos.size = remaining;
                    pos.average_price = price;
                } else {
                    pos.size += qty;
                }
            }
        }
        OrderSide::Sell => {
            if pos.size <= 0.0 {
                let new_short = pos.size.abs() + qty;
                pos.average_price = if new_short == 0.0 {
                    0.0
                } else {
                    (pos.average_price * pos.size.abs() + price * qty) / new_short
                };
                pos.size = -new_short;
            } else {
                let close_size = pos.size.min(qty);
                pos.realized_pnl += (price - pos.average_price) * close_size;
                let remaining = qty - close_size;
                if remaining > 0.0 {
                    pos.size = -remaining;
                    pos.average_price = price;
                } else {
                    pos.size -= qty;
                }
            }
        }
    }
}

// =============================================================================
// Positions Query
// =============================================================================

/// Build a positions snapshot from trade history.
///
/// Iterates through paginated trade history, accumulates per-asset
/// position data, and optionally fetches mid-market prices for
/// unrealised PnL calculation.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `params` - Positions query parameters
///
/// # Returns
///
/// `PositionsSummary` with individual positions and aggregate PnL.
pub async fn get_wallet_positions(
    client: &ClobClient,
    params: &PositionsQueryParams,
) -> Result<PositionsSummary> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for position queries",
        ));
    }

    let asset_filter = params.asset_ids.as_deref();
    let trades_response = client
        .get_trades(None, asset_filter, Some(params.limit), Some(params.max_pages))
        .await?;

    let trades_scanned = trades_response.data.len();

    // Build accumulators from trades
    let mut accumulators: HashMap<String, PositionAccumulator> = HashMap::new();

    for trade in &trades_response.data {
        let price = safe_parse(&trade.price);
        let size = safe_parse(&trade.size);

        if let Some(filter) = asset_filter {
            if !filter.iter().any(|id| id == &trade.token_id) {
                continue;
            }
        }

        let acc = accumulators
            .entry(trade.token_id.clone())
            .or_insert_with(|| PositionAccumulator {
                market: trade.market_id.clone(),
                asset_id: trade.token_id.clone(),
                size: 0.0,
                average_price: 0.0,
                realized_pnl: 0.0,
            });

        update_position_for_trade(acc, &trade.side, price, size);
    }

    // Build final positions, optionally fetching prices
    let mut positions = Vec::new();
    let mut total_realized = 0.0;
    let mut total_unrealized = 0.0;
    let mut price_lookups = 0;

    for acc in accumulators.values() {
        if acc.size.abs() < 0.000001 {
            continue;
        }

        let unrealized = if params.include_prices
            && acc.size.abs() > 0.0
            && price_lookups < params.price_lookup_limit
        {
            price_lookups += 1;
            match client.get_midpoint(&acc.asset_id).await {
                Ok(mid_str) => {
                    let mid = safe_parse(&mid_str);
                    if mid > 0.0 {
                        if acc.size > 0.0 {
                            (mid - acc.average_price) * acc.size
                        } else {
                            (acc.average_price - mid) * acc.size.abs()
                        }
                    } else {
                        0.0
                    }
                }
                Err(_) => 0.0,
            }
        } else {
            0.0
        };

        total_realized += acc.realized_pnl;
        total_unrealized += unrealized;

        positions.push(Position {
            market: acc.market.clone(),
            asset_id: acc.asset_id.clone(),
            size: format!("{:.6}", acc.size),
            average_price: format!("{:.6}", acc.average_price),
            realized_pnl: format!("{:.6}", acc.realized_pnl),
            unrealized_pnl: format!("{:.6}", unrealized),
        });
    }

    Ok(PositionsSummary {
        positions,
        trades_scanned,
        total_realized_pnl: total_realized,
        total_unrealized_pnl: total_unrealized,
    })
}

/// Format positions summary for display.
pub fn format_positions_summary(summary: &PositionsSummary) -> String {
    let mut lines = vec!["📊 **Positions Summary**\n".to_string()];

    if summary.positions.is_empty() {
        lines.push("No open positions found.".to_string());
        lines.push(format!(
            "\n*Scanned {} trades.*",
            summary.trades_scanned
        ));
        return lines.join("\n");
    }

    lines.push(format!(
        "**Open Positions:** {}\n",
        summary.positions.len()
    ));

    for (i, pos) in summary.positions.iter().enumerate() {
        let short_asset = if pos.asset_id.len() > 16 {
            format!("{}...", &pos.asset_id[..16])
        } else {
            pos.asset_id.clone()
        };

        let size_f: f64 = pos.size.parse().unwrap_or(0.0);
        let direction = if size_f > 0.0 { "LONG" } else { "SHORT" };

        lines.push(format!(
            "**{}. `{}`** — {} {:.4}",
            i + 1,
            short_asset,
            direction,
            size_f.abs()
        ));
        lines.push(format!("   Avg Price: {}", pos.average_price));
        lines.push(format!(
            "   Realised PnL: {} | Unrealised PnL: {}",
            pos.realized_pnl, pos.unrealized_pnl
        ));
        lines.push(String::new());
    }

    lines.push(format!(
        "**Total Realised PnL:** {:.4}",
        summary.total_realized_pnl
    ));
    lines.push(format!(
        "**Total Unrealised PnL:** {:.4}",
        summary.total_unrealized_pnl
    ));
    lines.push(format!(
        "\n*Scanned {} trades.*",
        summary.trades_scanned
    ));

    lines.join("\n")
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::OrderSide;

    // --- PositionAccumulator / update_position_for_trade ---

    #[test]
    fn test_buy_increases_long_position() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 0.0,
            average_price: 0.0,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.60, 10.0);
        assert!((acc.size - 10.0).abs() < 1e-9);
        assert!((acc.average_price - 0.60).abs() < 1e-9);
        assert!((acc.realized_pnl - 0.0).abs() < 1e-9);
    }

    #[test]
    fn test_sell_closes_long_with_realized_pnl() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 10.0,
            average_price: 0.50,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Sell, 0.70, 10.0);
        assert!(acc.size.abs() < 1e-9);
        // PnL = (0.70 - 0.50) * 10 = 2.0
        assert!((acc.realized_pnl - 2.0).abs() < 1e-9);
    }

    #[test]
    fn test_sell_partial_close_long() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 10.0,
            average_price: 0.40,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Sell, 0.60, 5.0);
        assert!((acc.size - 5.0).abs() < 1e-9);
        // PnL = (0.60 - 0.40) * 5 = 1.0
        assert!((acc.realized_pnl - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_sell_opens_short_position() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 0.0,
            average_price: 0.0,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Sell, 0.80, 5.0);
        assert!((acc.size - (-5.0)).abs() < 1e-9);
        assert!((acc.average_price - 0.80).abs() < 1e-9);
    }

    #[test]
    fn test_buy_closes_short_with_realized_pnl() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: -10.0,
            average_price: 0.80,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.60, 10.0);
        assert!(acc.size.abs() < 1e-9);
        // Short PnL = (0.80 - 0.60) * 10 = 2.0
        assert!((acc.realized_pnl - 2.0).abs() < 1e-9);
    }

    #[test]
    fn test_buy_flip_short_to_long() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: -5.0,
            average_price: 0.70,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.60, 8.0);
        // Close 5 short at profit, then open 3 long
        assert!((acc.size - 3.0).abs() < 1e-9);
        assert!((acc.average_price - 0.60).abs() < 1e-9);
        // PnL = (0.70 - 0.60) * 5 = 0.50
        assert!((acc.realized_pnl - 0.50).abs() < 1e-9);
    }

    #[test]
    fn test_zero_quantity_is_noop() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 10.0,
            average_price: 0.50,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.60, 0.0);
        assert!((acc.size - 10.0).abs() < 1e-9);
    }

    #[test]
    fn test_zero_price_is_noop() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 10.0,
            average_price: 0.50,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.0, 5.0);
        assert!((acc.size - 10.0).abs() < 1e-9);
    }

    #[test]
    fn test_weighted_average_price_multiple_buys() {
        let mut acc = PositionAccumulator {
            market: "m1".into(),
            asset_id: "a1".into(),
            size: 0.0,
            average_price: 0.0,
            realized_pnl: 0.0,
        };
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.40, 10.0);
        update_position_for_trade(&mut acc, &OrderSide::Buy, 0.60, 10.0);
        assert!((acc.size - 20.0).abs() < 1e-9);
        // avg = (0.40*10 + 0.60*10)/20 = 0.50
        assert!((acc.average_price - 0.50).abs() < 1e-9);
    }

    // --- PositionsQueryParams ---

    #[test]
    fn test_default_params() {
        let params = PositionsQueryParams::default();
        assert_eq!(params.limit, 500);
        assert_eq!(params.max_pages, 10);
        assert!(params.include_prices);
        assert_eq!(params.price_lookup_limit, 10);
        assert!(params.asset_ids.is_none());
    }

    // --- PositionsSummary serialization ---

    #[test]
    fn test_summary_serialization() {
        let summary = PositionsSummary {
            positions: vec![Position {
                market: "m1".into(),
                asset_id: "a1".into(),
                size: "10.000000".into(),
                average_price: "0.500000".into(),
                realized_pnl: "0.000000".into(),
                unrealized_pnl: "1.500000".into(),
            }],
            trades_scanned: 42,
            total_realized_pnl: 0.0,
            total_unrealized_pnl: 1.5,
        };

        let json = serde_json::to_string(&summary).expect("serialize");
        assert!(json.contains("10.000000"));
        assert!(json.contains("42"));
    }

    // --- Formatting ---

    #[test]
    fn test_format_empty_positions() {
        let summary = PositionsSummary {
            positions: vec![],
            trades_scanned: 100,
            total_realized_pnl: 0.0,
            total_unrealized_pnl: 0.0,
        };
        let text = format_positions_summary(&summary);
        assert!(text.contains("No open positions"));
        assert!(text.contains("100 trades"));
    }

    #[test]
    fn test_format_positions_with_data() {
        let summary = PositionsSummary {
            positions: vec![
                Position {
                    market: "m1".into(),
                    asset_id: "0xaabbccdd11223344aabbccdd11223344".into(),
                    size: "10.000000".into(),
                    average_price: "0.500000".into(),
                    realized_pnl: "0.000000".into(),
                    unrealized_pnl: "2.000000".into(),
                },
                Position {
                    market: "m2".into(),
                    asset_id: "short-id".into(),
                    size: "-5.000000".into(),
                    average_price: "0.700000".into(),
                    realized_pnl: "1.000000".into(),
                    unrealized_pnl: "-0.500000".into(),
                },
            ],
            trades_scanned: 250,
            total_realized_pnl: 1.0,
            total_unrealized_pnl: 1.5,
        };
        let text = format_positions_summary(&summary);
        assert!(text.contains("Positions Summary"));
        assert!(text.contains("LONG"));
        assert!(text.contains("SHORT"));
        assert!(text.contains("0xaabbccdd112233...")); // truncated
        assert!(text.contains("short-id")); // not truncated
        assert!(text.contains("Total Realised PnL"));
    }
}
