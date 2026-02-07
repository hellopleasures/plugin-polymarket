//! Dedicated balance action module for Polymarket.
//!
//! Provides wallet balance queries for both collateral (USDC) and
//! conditional tokens, with formatting helpers for display.

use crate::client::ClobClient;
use crate::error::{PolymarketError, Result};
use crate::types::BalanceAllowance;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Types
// =============================================================================

/// Configuration for a balance query.
#[derive(Debug, Clone, Default)]
pub struct BalanceQueryParams {
    /// Specific token IDs to query conditional balances for.
    pub token_ids: Option<Vec<String>>,
    /// Whether to include collateral (USDC) balance.
    pub include_collateral: bool,
    /// Whether to include conditional token balances.
    pub include_conditional: bool,
    /// Maximum number of token balances to fetch.
    pub max_tokens: usize,
}

impl BalanceQueryParams {
    /// Create default params that include everything.
    pub fn all() -> Self {
        Self {
            token_ids: None,
            include_collateral: true,
            include_conditional: true,
            max_tokens: 25,
        }
    }

    /// Create params for collateral-only query.
    pub fn collateral_only() -> Self {
        Self {
            token_ids: None,
            include_collateral: true,
            include_conditional: false,
            max_tokens: 0,
        }
    }
}

/// Result of a balance query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceResult {
    /// Collateral (USDC) balance and allowance.
    pub collateral: Option<BalanceAllowance>,
    /// Conditional token balances keyed by token ID.
    pub token_balances: HashMap<String, BalanceAllowance>,
    /// Number of token balances returned.
    pub token_count: usize,
}

// =============================================================================
// Balance Query
// =============================================================================

/// Get wallet balances for collateral and/or conditional tokens.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `params` - Balance query parameters
///
/// # Returns
///
/// Balance result containing collateral and token balances.
///
/// # Errors
///
/// Returns `PolymarketError` if:
/// - Client is not authenticated
/// - Neither collateral nor conditional is requested
/// - API request fails
pub async fn get_wallet_balances(
    client: &ClobClient,
    params: &BalanceQueryParams,
) -> Result<BalanceResult> {
    if !params.include_collateral && !params.include_conditional {
        return Err(PolymarketError::invalid_order(
            "At least one of include_collateral or include_conditional must be true",
        ));
    }

    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for balance queries",
        ));
    }

    let mut result = BalanceResult {
        collateral: None,
        token_balances: HashMap::new(),
        token_count: 0,
    };

    if params.include_collateral {
        let balance = client.get_collateral_balance().await?;
        result.collateral = Some(balance);
    }

    if params.include_conditional {
        if let Some(ref tokens) = params.token_ids {
            let limited = if params.max_tokens > 0 {
                &tokens[..tokens.len().min(params.max_tokens)]
            } else {
                tokens.as_slice()
            };

            for token_id in limited {
                match client.get_conditional_balance(token_id).await {
                    Ok(balance) => {
                        result.token_balances.insert(token_id.clone(), balance);
                    }
                    Err(e) => {
                        eprintln!(
                            "Warning: Failed to get balance for token {}: {}",
                            token_id, e
                        );
                    }
                }
            }
        }
        result.token_count = result.token_balances.len();
    }

    Ok(result)
}

/// Format balance result for display.
pub fn format_balance_result(result: &BalanceResult) -> String {
    let mut lines = vec!["💰 **Wallet Balances**\n".to_string()];

    if let Some(ref collateral) = result.collateral {
        lines.push(format!(
            "**Collateral (USDC):** {} (allowance: {})",
            collateral.balance, collateral.allowance
        ));
    }

    if !result.token_balances.is_empty() {
        lines.push(format!(
            "\n**Conditional Tokens:** ({} tokens)\n",
            result.token_count
        ));
        for (token_id, ba) in &result.token_balances {
            let short_id = if token_id.len() > 16 {
                format!("{}...", &token_id[..16])
            } else {
                token_id.clone()
            };
            lines.push(format!(
                "• `{}` — balance: {}, allowance: {}",
                short_id, ba.balance, ba.allowance
            ));
        }
    } else if result.token_count == 0 && result.collateral.is_some() {
        lines.push("\nNo conditional token balances found.".to_string());
    }

    lines.join("\n")
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_balance_query_params_all() {
        let params = BalanceQueryParams::all();
        assert!(params.include_collateral);
        assert!(params.include_conditional);
        assert_eq!(params.max_tokens, 25);
        assert!(params.token_ids.is_none());
    }

    #[test]
    fn test_balance_query_params_collateral_only() {
        let params = BalanceQueryParams::collateral_only();
        assert!(params.include_collateral);
        assert!(!params.include_conditional);
        assert_eq!(params.max_tokens, 0);
    }

    #[test]
    fn test_balance_result_serialization() {
        let result = BalanceResult {
            collateral: Some(BalanceAllowance {
                balance: "100.50".to_string(),
                allowance: "1000000".to_string(),
            }),
            token_balances: HashMap::from([(
                "token123".to_string(),
                BalanceAllowance {
                    balance: "50".to_string(),
                    allowance: "50".to_string(),
                },
            )]),
            token_count: 1,
        };

        let json = serde_json::to_string(&result).expect("serialization");
        assert!(json.contains("100.50"));
        assert!(json.contains("token123"));

        let deser: BalanceResult = serde_json::from_str(&json).expect("deserialization");
        assert_eq!(deser.collateral.unwrap().balance, "100.50");
        assert_eq!(deser.token_count, 1);
    }

    #[test]
    fn test_format_balance_result_with_collateral() {
        let result = BalanceResult {
            collateral: Some(BalanceAllowance {
                balance: "250.00".to_string(),
                allowance: "1000000".to_string(),
            }),
            token_balances: HashMap::new(),
            token_count: 0,
        };
        let formatted = format_balance_result(&result);
        assert!(formatted.contains("Wallet Balances"));
        assert!(formatted.contains("250.00"));
        assert!(formatted.contains("Collateral (USDC)"));
    }

    #[test]
    fn test_format_balance_result_with_tokens() {
        let result = BalanceResult {
            collateral: None,
            token_balances: HashMap::from([(
                "0xabcdef1234567890abcdef1234567890".to_string(),
                BalanceAllowance {
                    balance: "100".to_string(),
                    allowance: "100".to_string(),
                },
            )]),
            token_count: 1,
        };
        let formatted = format_balance_result(&result);
        assert!(formatted.contains("Conditional Tokens"));
        assert!(formatted.contains("1 tokens"));
        assert!(formatted.contains("0xabcdef12345678...")); // truncated
    }

    #[test]
    fn test_format_balance_result_empty() {
        let result = BalanceResult {
            collateral: Some(BalanceAllowance {
                balance: "0".to_string(),
                allowance: "0".to_string(),
            }),
            token_balances: HashMap::new(),
            token_count: 0,
        };
        let formatted = format_balance_result(&result);
        assert!(formatted.contains("No conditional token balances"));
    }
}
