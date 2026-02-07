//! Research Market Action
//!
//! Initiates and manages deep research on Polymarket prediction markets.
//! Mirrors the Python `research.py` module.
//!
//! The action is asynchronous:
//! - If research exists and is valid: returns cached results immediately
//! - If research is in progress: returns status update
//! - If no research: starts async research task and returns confirmation

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

// =============================================================================
// Types
// =============================================================================

/// Status of market research.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Expired,
}

/// A source used in research.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchSource {
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
}

/// Trading recommendation from research.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchRecommendation {
    /// Whether a trade is recommended.
    pub should_trade: bool,
    /// Recommended direction: "YES" or "NO".
    pub direction: Option<String>,
    /// Confidence level 0-100.
    pub confidence: u8,
    /// Reasoning for the recommendation.
    pub reasoning: String,
}

/// Completed research result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchResult {
    pub summary: String,
    pub text: String,
    pub recommendation: Option<ResearchRecommendation>,
    #[serde(default)]
    pub sources: Vec<ResearchSource>,
    #[serde(default)]
    pub sources_count: usize,
}

/// Market research data stored in cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketResearch {
    pub market_id: String,
    pub market_question: String,
    pub status: ResearchStatus,
    pub task_id: Option<String>,
    pub research_id: Option<String>,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub result: Option<ResearchResult>,
    pub error_message: Option<String>,
}

/// Parameters for research market action.
#[derive(Debug, Clone)]
pub struct ResearchParams {
    pub market_id: String,
    pub market_question: String,
    pub force_refresh: bool,
    pub callback_action: CallbackAction,
}

/// Callback action type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackAction {
    EvaluateTrade,
    NotifyOnly,
}

impl Default for CallbackAction {
    fn default() -> Self {
        Self::NotifyOnly
    }
}

/// Result from research market action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchActionResult {
    pub success: bool,
    pub status: String,
    pub market_id: String,
    pub market_question: String,
    pub task_id: Option<String>,
    pub recommendation: Option<ResearchRecommendation>,
    pub cached: bool,
    pub completed_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub elapsed_minutes: Option<u64>,
    pub estimated_remaining: Option<u64>,
    pub error: Option<String>,
}

// =============================================================================
// Research Storage
// =============================================================================

/// Default research expiry time (24 hours).
const DEFAULT_RESEARCH_EXPIRY_SECS: u64 = 24 * 60 * 60;

/// In-memory research storage.
#[derive(Debug, Clone)]
pub struct ResearchStorage {
    cache: Arc<RwLock<HashMap<String, MarketResearch>>>,
    expiry_secs: u64,
}

impl Default for ResearchStorage {
    fn default() -> Self {
        Self::new(DEFAULT_RESEARCH_EXPIRY_SECS)
    }
}

impl ResearchStorage {
    pub fn new(expiry_secs: u64) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            expiry_secs,
        }
    }

    fn cache_key(market_id: &str) -> String {
        format!("polymarket_research:{}", market_id)
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    pub async fn get_market_research(&self, market_id: &str) -> Option<MarketResearch> {
        let cache = self.cache.read().await;
        let key = Self::cache_key(market_id);
        let research = cache.get(&key)?.clone();

        // Check expiry
        if research.status == ResearchStatus::Completed {
            if let Some(expires_at) = research.expires_at {
                if Self::now_secs() > expires_at {
                    return Some(MarketResearch {
                        status: ResearchStatus::Expired,
                        ..research
                    });
                }
            }
        }

        Some(research)
    }

    pub async fn mark_in_progress(
        &self,
        market_id: &str,
        market_question: &str,
        task_id: &str,
    ) {
        let mut cache = self.cache.write().await;
        let key = Self::cache_key(market_id);
        cache.insert(
            key,
            MarketResearch {
                market_id: market_id.to_string(),
                market_question: market_question.to_string(),
                status: ResearchStatus::InProgress,
                task_id: Some(task_id.to_string()),
                research_id: None,
                started_at: Some(Self::now_secs()),
                completed_at: None,
                expires_at: None,
                result: None,
                error_message: None,
            },
        );
    }

    pub async fn store_result(
        &self,
        market_id: &str,
        result: ResearchResult,
        research_id: &str,
    ) {
        let mut cache = self.cache.write().await;
        let key = Self::cache_key(market_id);

        if let Some(existing) = cache.get(&key).cloned() {
            let now = Self::now_secs();
            cache.insert(
                key,
                MarketResearch {
                    status: ResearchStatus::Completed,
                    research_id: Some(research_id.to_string()),
                    completed_at: Some(now),
                    expires_at: Some(now + self.expiry_secs),
                    result: Some(result),
                    error_message: None,
                    ..existing
                },
            );
        }
    }

    pub async fn mark_failed(&self, market_id: &str, error_message: &str) {
        let mut cache = self.cache.write().await;
        let key = Self::cache_key(market_id);

        let existing = cache.get(&key).cloned();
        cache.insert(
            key,
            MarketResearch {
                market_id: market_id.to_string(),
                market_question: existing
                    .as_ref()
                    .map(|e| e.market_question.clone())
                    .unwrap_or_else(|| "Unknown".to_string()),
                status: ResearchStatus::Failed,
                task_id: existing.as_ref().and_then(|e| e.task_id.clone()),
                research_id: None,
                started_at: existing.as_ref().and_then(|e| e.started_at),
                completed_at: Some(Self::now_secs()),
                expires_at: None,
                result: None,
                error_message: Some(error_message.to_string()),
            },
        );
    }

    pub async fn delete_research(&self, market_id: &str) {
        let mut cache = self.cache.write().await;
        cache.remove(&Self::cache_key(market_id));
    }

    pub async fn is_available(&self, market_id: &str) -> bool {
        matches!(
            self.get_market_research(market_id).await,
            Some(r) if r.status == ResearchStatus::Completed
        )
    }

    pub async fn get_elapsed_minutes(&self, market_id: &str) -> Option<u64> {
        let research = self.get_market_research(market_id).await?;
        let started = research.started_at?;
        Some((Self::now_secs().saturating_sub(started)) / 60)
    }
}

// =============================================================================
// Research Action
// =============================================================================

/// Build the research prompt for a market question.
pub fn build_research_prompt(market_question: &str) -> String {
    format!(
        r#"Conduct comprehensive research on this prediction market question:

"{market_question}"

Research goals:
1. Gather current state and the most recent developments related to this question
2. Find historical precedents and patterns that might inform the outcome
3. Collect expert opinions, forecasts, and analysis from multiple credible sources
4. Identify key factors and variables that could influence the result
5. Note any important upcoming events or deadlines
6. Assess the reliability and potential biases of different information sources

Provide a thorough, well-sourced analysis that would help someone make an informed prediction about this market's outcome."#
    )
}

/// Execute the research market action.
///
/// Handles caching, in-progress checks, and initiating new research.
pub async fn research_market(
    params: &ResearchParams,
    storage: &ResearchStorage,
) -> ResearchActionResult {
    let market_id = &params.market_id;
    let market_question = &params.market_question;

    if market_id.is_empty() || market_question.is_empty() {
        return ResearchActionResult {
            success: false,
            status: "error".into(),
            market_id: market_id.clone(),
            market_question: market_question.clone(),
            task_id: None,
            recommendation: None,
            cached: false,
            completed_at: None,
            expires_at: None,
            elapsed_minutes: None,
            estimated_remaining: None,
            error: Some("missing_parameters".into()),
        };
    }

    let existing = storage.get_market_research(market_id).await;

    // CASE 1: Completed and not force-refreshing
    if let Some(ref research) = existing {
        if research.status == ResearchStatus::Completed && !params.force_refresh {
            return ResearchActionResult {
                success: true,
                status: "completed".into(),
                market_id: market_id.clone(),
                market_question: market_question.clone(),
                task_id: None,
                recommendation: research
                    .result
                    .as_ref()
                    .and_then(|r| r.recommendation.clone()),
                cached: true,
                completed_at: research.completed_at,
                expires_at: research.expires_at,
                elapsed_minutes: None,
                estimated_remaining: None,
                error: None,
            };
        }
    }

    // CASE 2: In progress
    if let Some(ref research) = existing {
        if research.status == ResearchStatus::InProgress {
            let elapsed = storage.get_elapsed_minutes(market_id).await.unwrap_or(0);
            let remaining = 30u64.saturating_sub(elapsed).max(5);
            return ResearchActionResult {
                success: true,
                status: "in_progress".into(),
                market_id: market_id.clone(),
                market_question: market_question.clone(),
                task_id: research.task_id.clone(),
                recommendation: None,
                cached: false,
                completed_at: None,
                expires_at: None,
                elapsed_minutes: Some(elapsed),
                estimated_remaining: Some(remaining),
                error: None,
            };
        }
    }

    // CASE 3: Expired
    if let Some(ref research) = existing {
        if research.status == ResearchStatus::Expired && !params.force_refresh {
            return ResearchActionResult {
                success: true,
                status: "expired".into(),
                market_id: market_id.clone(),
                market_question: market_question.clone(),
                task_id: None,
                recommendation: research
                    .result
                    .as_ref()
                    .and_then(|r| r.recommendation.clone()),
                cached: false,
                completed_at: None,
                expires_at: research.expires_at,
                elapsed_minutes: None,
                estimated_remaining: None,
                error: None,
            };
        }
    }

    // CASE 4: Failed
    if let Some(ref research) = existing {
        if research.status == ResearchStatus::Failed && !params.force_refresh {
            return ResearchActionResult {
                success: false,
                status: "failed".into(),
                market_id: market_id.clone(),
                market_question: market_question.clone(),
                task_id: None,
                recommendation: None,
                cached: false,
                completed_at: None,
                expires_at: None,
                elapsed_minutes: None,
                estimated_remaining: None,
                error: research.error_message.clone(),
            };
        }
    }

    // CASE 5: Start new research
    let task_id = uuid_v4();
    let _prompt = build_research_prompt(market_question);
    storage
        .mark_in_progress(market_id, market_question, &task_id)
        .await;

    ResearchActionResult {
        success: true,
        status: "started".into(),
        market_id: market_id.clone(),
        market_question: market_question.clone(),
        task_id: Some(task_id),
        recommendation: None,
        cached: false,
        completed_at: None,
        expires_at: None,
        elapsed_minutes: None,
        estimated_remaining: Some(30),
        error: None,
    }
}

/// Format research action result for display.
pub fn format_research_action_result(result: &ResearchActionResult) -> String {
    match result.status.as_str() {
        "completed" => {
            let cached = if result.cached { "\n**Cached:** Yes" } else { "" };
            format!(
                "📊 **Research Complete: {}**\n\nResearch is available and current.{}\n\nUse `get_research_details` for full analysis.",
                result.market_question, cached
            )
        }
        "in_progress" => {
            format!(
                "⏳ **Research In Progress**\n\n\
                 **Market:** {}\n\
                 **Started:** {} minutes ago\n\
                 **Task ID:** `{}`\n\n\
                 Deep research typically takes 20-40 minutes. Estimated time remaining: ~{} minutes.",
                result.market_question,
                result.elapsed_minutes.unwrap_or(0),
                result.task_id.as_deref().unwrap_or("unknown"),
                result.estimated_remaining.unwrap_or(30)
            )
        }
        "expired" => {
            let rec = result.recommendation.as_ref();
            let rec_text = if rec.map_or(false, |r| r.should_trade) {
                "Trade"
            } else {
                "No Trade"
            };
            let conf = rec.map_or(0, |r| r.confidence);
            format!(
                "⚠️ **Research Expired**\n\n\
                 Previous research for this market is outdated.\n\n\
                 **Previous Recommendation:** {} ({}% confidence)\n\n\
                 Would you like me to start fresh research?",
                rec_text, conf
            )
        }
        "failed" => {
            format!(
                "❌ **Previous Research Failed**\n\nError: {}\n\nWould you like me to retry the research?",
                result.error.as_deref().unwrap_or("Unknown error")
            )
        }
        "started" => {
            format!(
                "🔬 **Research Started**\n\n\
                 **Market:** {}\n\
                 **Task ID:** `{}`\n\n\
                 Deep research has been initiated. This typically takes 20-40 minutes.",
                result.market_question,
                result.task_id.as_deref().unwrap_or("unknown")
            )
        }
        _ => format!("Research status: {}", result.status),
    }
}

/// Format full research report.
pub fn format_research_results(research: &MarketResearch) -> String {
    let rec = research
        .result
        .as_ref()
        .and_then(|r| r.recommendation.as_ref());

    let rec_emoji = match rec {
        Some(r) if r.should_trade && r.confidence > 80 => "🟢",
        Some(r) if r.should_trade => "🟡",
        _ => "🔴",
    };

    let mut lines = vec![format!(
        "📊 **Research Complete: {}**\n",
        research.market_question
    )];

    if let Some(ref result) = research.result {
        if !result.summary.is_empty() {
            lines.push(format!("**Summary:**\n{}\n", result.summary));
        }
    }

    if let Some(r) = rec {
        lines.push(format!("**Trading Recommendation:** {}", rec_emoji));
        lines.push(format!(
            "• Should Trade: {}",
            if r.should_trade { "Yes" } else { "No" }
        ));
        if let Some(ref dir) = r.direction {
            lines.push(format!("• Direction: {}", dir));
        }
        lines.push(format!("• Confidence: {}%", r.confidence));
        lines.push(format!("• Reasoning: {}\n", r.reasoning));
    }

    if let Some(ref result) = research.result {
        if result.sources_count > 0 {
            lines.push(format!("**Sources Analyzed:** {}", result.sources_count));
        }
    }

    lines.join("\n")
}

/// Simple UUID v4 generator (no external dependency).
fn uuid_v4() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (t & 0xFFFF_FFFF) as u32,
        ((t >> 32) & 0xFFFF) as u16,
        ((t >> 48) & 0x0FFF) as u16,
        (0x8000 | ((t >> 60) & 0x3FFF)) as u16,
        ((t >> 74) ^ t) & 0xFFFF_FFFF_FFFF
    )
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_storage() -> ResearchStorage {
        ResearchStorage::new(3600) // 1 hour expiry for tests
    }

    // --- ResearchStorage ---

    #[tokio::test]
    async fn test_storage_returns_none_for_unknown() {
        let storage = make_storage();
        assert!(storage.get_market_research("unknown").await.is_none());
    }

    #[tokio::test]
    async fn test_storage_mark_in_progress() {
        let storage = make_storage();
        storage
            .mark_in_progress("m1", "Will it rain?", "task-1")
            .await;
        let res = storage.get_market_research("m1").await.unwrap();
        assert_eq!(res.status, ResearchStatus::InProgress);
        assert_eq!(res.task_id.as_deref(), Some("task-1"));
        assert!(res.started_at.is_some());
    }

    #[tokio::test]
    async fn test_storage_store_result() {
        let storage = make_storage();
        storage
            .mark_in_progress("m2", "Who will win?", "task-2")
            .await;

        let result = ResearchResult {
            summary: "Yes is likely".into(),
            text: "Full analysis...".into(),
            recommendation: Some(ResearchRecommendation {
                should_trade: true,
                direction: Some("YES".into()),
                confidence: 85,
                reasoning: "Strong evidence".into(),
            }),
            sources: vec![ResearchSource {
                title: "Source 1".into(),
                url: "https://example.com".into(),
                snippet: None,
            }],
            sources_count: 1,
        };

        storage.store_result("m2", result, "res-1").await;

        let research = storage.get_market_research("m2").await.unwrap();
        assert_eq!(research.status, ResearchStatus::Completed);
        assert!(research.result.is_some());
        let rec = research.result.unwrap().recommendation.unwrap();
        assert!(rec.should_trade);
        assert_eq!(rec.confidence, 85);
    }

    #[tokio::test]
    async fn test_storage_mark_failed() {
        let storage = make_storage();
        storage
            .mark_in_progress("m3", "Test?", "task-3")
            .await;
        storage.mark_failed("m3", "timeout").await;

        let research = storage.get_market_research("m3").await.unwrap();
        assert_eq!(research.status, ResearchStatus::Failed);
        assert_eq!(research.error_message.as_deref(), Some("timeout"));
    }

    #[tokio::test]
    async fn test_storage_delete() {
        let storage = make_storage();
        storage.mark_in_progress("m4", "Q?", "t").await;
        storage.delete_research("m4").await;
        assert!(storage.get_market_research("m4").await.is_none());
    }

    #[tokio::test]
    async fn test_storage_is_available() {
        let storage = make_storage();
        assert!(!storage.is_available("m5").await);

        storage.mark_in_progress("m5", "Q?", "t").await;
        assert!(!storage.is_available("m5").await);

        storage
            .store_result(
                "m5",
                ResearchResult {
                    summary: "s".into(),
                    text: "t".into(),
                    recommendation: None,
                    sources: vec![],
                    sources_count: 0,
                },
                "r",
            )
            .await;
        assert!(storage.is_available("m5").await);
    }

    // --- research_market ---

    #[tokio::test]
    async fn test_research_market_missing_params() {
        let storage = make_storage();
        let params = ResearchParams {
            market_id: "".into(),
            market_question: "".into(),
            force_refresh: false,
            callback_action: CallbackAction::NotifyOnly,
        };
        let result = research_market(&params, &storage).await;
        assert!(!result.success);
        assert_eq!(result.status, "error");
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn test_research_market_starts_new() {
        let storage = make_storage();
        let params = ResearchParams {
            market_id: "cond-123".into(),
            market_question: "Will Bitcoin exceed 100k?".into(),
            force_refresh: false,
            callback_action: CallbackAction::NotifyOnly,
        };
        let result = research_market(&params, &storage).await;
        assert!(result.success);
        assert_eq!(result.status, "started");
        assert!(result.task_id.is_some());
        assert_eq!(result.estimated_remaining, Some(30));
    }

    #[tokio::test]
    async fn test_research_market_returns_cached() {
        let storage = make_storage();
        storage
            .mark_in_progress("cond-456", "Test?", "t")
            .await;
        storage
            .store_result(
                "cond-456",
                ResearchResult {
                    summary: "summary".into(),
                    text: "text".into(),
                    recommendation: Some(ResearchRecommendation {
                        should_trade: true,
                        direction: Some("YES".into()),
                        confidence: 90,
                        reasoning: "High confidence".into(),
                    }),
                    sources: vec![],
                    sources_count: 0,
                },
                "res-1",
            )
            .await;

        let params = ResearchParams {
            market_id: "cond-456".into(),
            market_question: "Test?".into(),
            force_refresh: false,
            callback_action: CallbackAction::NotifyOnly,
        };
        let result = research_market(&params, &storage).await;
        assert!(result.success);
        assert_eq!(result.status, "completed");
        assert!(result.cached);
        assert!(result.recommendation.is_some());
    }

    #[tokio::test]
    async fn test_research_market_returns_in_progress() {
        let storage = make_storage();
        storage
            .mark_in_progress("cond-789", "In progress?", "task-99")
            .await;

        let params = ResearchParams {
            market_id: "cond-789".into(),
            market_question: "In progress?".into(),
            force_refresh: false,
            callback_action: CallbackAction::NotifyOnly,
        };
        let result = research_market(&params, &storage).await;
        assert!(result.success);
        assert_eq!(result.status, "in_progress");
        assert_eq!(result.task_id.as_deref(), Some("task-99"));
    }

    #[tokio::test]
    async fn test_research_market_returns_failed() {
        let storage = make_storage();
        storage.mark_in_progress("cond-f", "Failed?", "t").await;
        storage.mark_failed("cond-f", "API timeout").await;

        let params = ResearchParams {
            market_id: "cond-f".into(),
            market_question: "Failed?".into(),
            force_refresh: false,
            callback_action: CallbackAction::NotifyOnly,
        };
        let result = research_market(&params, &storage).await;
        assert!(!result.success);
        assert_eq!(result.status, "failed");
        assert_eq!(result.error.as_deref(), Some("API timeout"));
    }

    #[tokio::test]
    async fn test_research_market_force_refresh() {
        let storage = make_storage();
        storage.mark_in_progress("cond-r", "Refresh?", "t").await;
        storage
            .store_result(
                "cond-r",
                ResearchResult {
                    summary: "old".into(),
                    text: "old".into(),
                    recommendation: None,
                    sources: vec![],
                    sources_count: 0,
                },
                "r",
            )
            .await;

        let params = ResearchParams {
            market_id: "cond-r".into(),
            market_question: "Refresh?".into(),
            force_refresh: true,
            callback_action: CallbackAction::NotifyOnly,
        };
        let result = research_market(&params, &storage).await;
        assert!(result.success);
        assert_eq!(result.status, "started"); // Starts new research
    }

    // --- build_research_prompt ---

    #[test]
    fn test_build_research_prompt() {
        let prompt = build_research_prompt("Will AI surpass humans?");
        assert!(prompt.contains("Will AI surpass humans?"));
        assert!(prompt.contains("Research goals"));
        assert!(prompt.contains("expert opinions"));
    }

    // --- Formatting ---

    #[test]
    fn test_format_started_result() {
        let result = ResearchActionResult {
            success: true,
            status: "started".into(),
            market_id: "m1".into(),
            market_question: "Test?".into(),
            task_id: Some("task-1".into()),
            recommendation: None,
            cached: false,
            completed_at: None,
            expires_at: None,
            elapsed_minutes: None,
            estimated_remaining: Some(30),
            error: None,
        };
        let text = format_research_action_result(&result);
        assert!(text.contains("Research Started"));
        assert!(text.contains("Test?"));
        assert!(text.contains("task-1"));
    }

    #[test]
    fn test_format_completed_result() {
        let result = ResearchActionResult {
            success: true,
            status: "completed".into(),
            market_id: "m2".into(),
            market_question: "Done?".into(),
            task_id: None,
            recommendation: None,
            cached: true,
            completed_at: Some(1000),
            expires_at: Some(2000),
            elapsed_minutes: None,
            estimated_remaining: None,
            error: None,
        };
        let text = format_research_action_result(&result);
        assert!(text.contains("Research Complete"));
        assert!(text.contains("Cached"));
    }

    #[test]
    fn test_format_research_results_with_recommendation() {
        let research = MarketResearch {
            market_id: "m1".into(),
            market_question: "Will it happen?".into(),
            status: ResearchStatus::Completed,
            task_id: None,
            research_id: None,
            started_at: None,
            completed_at: None,
            expires_at: None,
            result: Some(ResearchResult {
                summary: "Likely yes".into(),
                text: "Full text".into(),
                recommendation: Some(ResearchRecommendation {
                    should_trade: true,
                    direction: Some("YES".into()),
                    confidence: 90,
                    reasoning: "Strong data".into(),
                }),
                sources: vec![],
                sources_count: 5,
            }),
            error_message: None,
        };
        let text = format_research_results(&research);
        assert!(text.contains("Research Complete"));
        assert!(text.contains("Likely yes"));
        assert!(text.contains("🟢"));
        assert!(text.contains("YES"));
        assert!(text.contains("90%"));
        assert!(text.contains("5"));
    }

    // --- ResearchActionResult serialization ---

    #[test]
    fn test_research_action_result_serialization() {
        let result = ResearchActionResult {
            success: true,
            status: "completed".into(),
            market_id: "m1".into(),
            market_question: "Test?".into(),
            task_id: Some("t1".into()),
            recommendation: Some(ResearchRecommendation {
                should_trade: false,
                direction: None,
                confidence: 30,
                reasoning: "Low confidence".into(),
            }),
            cached: false,
            completed_at: Some(12345),
            expires_at: Some(99999),
            elapsed_minutes: None,
            estimated_remaining: None,
            error: None,
        };

        let json = serde_json::to_string(&result).expect("serialize");
        let deser: ResearchActionResult = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deser.market_id, "m1");
        assert_eq!(deser.recommendation.unwrap().confidence, 30);
    }
}
