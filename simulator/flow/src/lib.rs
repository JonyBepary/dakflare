//! Deterministic flow interpreter.
//!
//! Pure by design: a graph plus a message in, a list of actions out. No clock, no
//! network, no randomness — so the same graph produces the same result on the
//! desktop simulator, on Android, and in the Worker's WASM fallback. The caller
//! performs the actions.
//!
//! The graph is the canonical IR (`ir.rs`), which is what the dashboard canvas
//! produces and the Worker validates:
//!
//! ```text
//! trigger -> extract -> condition -true->  send_sms -> stop
//!                                  \-false-> stop
//! ```
//!
//! Nine kinds, all of them pure. `delay`, `webhook` and `send_sms` become
//! ACTIONS in the order the graph visits them, so a caller that performs the
//! list in order gets the ordering the graph asked for and this crate never
//! touches a clock.

pub mod ir;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use ir::{FlowGraph, Issue, UiLayout};

pub use ir::{Edge, Node, Position};

use ir::{
    named_groups, template_names, MAX_DELAY_SECONDS, MAX_SMS_BODY_CHARS, MAX_STEPS,
};

/* ------------------------------------------------------------------ input */

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub sender: String,
    pub body: String,
    #[serde(default)]
    pub received_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RunInput {
    pub graph: FlowGraph,
    pub message: Message,
}

/* ----------------------------------------------------------------- output */

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Wait `seconds`, then continue. The caller owns the clock.
    Delay { seconds: i64 },
    /// POST `body` to `url`. The caller owns the network.
    Webhook { url: String, body: String },
    /// Send one SMS. The caller owns the radio.
    SendSms { to: String, body: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub node_id: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub matched: bool,
    pub outcome: String,
    pub actions: Vec<Action>,
    pub variables: BTreeMap<String, String>,
    pub steps: Vec<Step>,
    pub error: Option<String>,
}

/// A trace IS a run: every step, every action, every variable it settled on. The
/// name exists because that is how it is consumed (`dakflare rules test`,
/// `flows apply --dry-run`), not because it is a different value.
pub type SimulationTrace = RunResult;

impl RunResult {
    fn new(matched: bool, outcome: &str) -> Self {
        Self {
            matched,
            outcome: outcome.to_string(),
            actions: Vec::new(),
            variables: BTreeMap::new(),
            steps: Vec::new(),
            error: None,
        }
    }
}

/* ------------------------------------------------------------- node data */

#[derive(Debug, Default, Deserialize)]
struct TriggerData {
    #[serde(default)]
    sender: Option<Filter>,
    #[serde(default)]
    body: Option<Filter>,
}

#[derive(Debug, Deserialize)]
struct Filter {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default)]
    value: Option<String>,
}

fn default_mode() -> String {
    "any".to_string()
}

#[derive(Debug, Deserialize)]
struct ExtractData {
    #[serde(default = "default_source")]
    source: String,
    pattern: String,
    #[serde(default)]
    flags: Option<String>,
}

fn default_source() -> String {
    "body".to_string()
}

#[derive(Debug, Deserialize)]
struct SetVarData {
    name: String,
    #[serde(default)]
    value: String,
}

#[derive(Debug, Deserialize)]
struct ConditionData {
    left: String,
    op: String,
    #[serde(default)]
    right: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwitchData {
    #[serde(default)]
    value: String,
    #[serde(default)]
    cases: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct DelayData {
    #[serde(default)]
    seconds: i64,
}

#[derive(Debug, Deserialize)]
struct WebhookData {
    #[serde(default)]
    url: String,
    #[serde(default)]
    body: String,
}

#[derive(Debug, Deserialize)]
struct SendSmsData {
    to: String,
    body: String,
}

/* ------------------------------------------------------------------- run */

/// Execute a graph against one message. Never panics on bad input: malformed
/// nodes produce `outcome = "error"` with a message.
pub fn run(input: &RunInput) -> RunResult {
    let graph = &input.graph;
    let trigger = match graph.nodes.iter().find(|node| node.kind == "trigger") {
        Some(node) => node,
        None => {
            let mut result = RunResult::new(false, "no_trigger");
            result.error = Some("graph has no trigger node".into());
            return result;
        }
    };

    let mut result = RunResult::new(false, "filtered");
    result.variables.insert("sender".into(), input.message.sender.clone());
    result.variables.insert("body".into(), input.message.body.clone());
    result.variables.insert(
        "received_at".into(),
        input.message.received_at.unwrap_or(0).to_string(),
    );

    // --- trigger filters -------------------------------------------------
    let trigger_data: TriggerData = match serde_json::from_value(trigger.data.clone()) {
        Ok(data) => data,
        Err(e) => return fail(result, format!("trigger data: {e}")),
    };
    if !matches_filter(&input.message.sender, trigger_data.sender.as_ref()) {
        result.steps.push(step(trigger, "sender filter did not match"));
        return result;
    }
    if !matches_filter(&input.message.body, trigger_data.body.as_ref()) {
        result.steps.push(step(trigger, "body filter did not match"));
        return result;
    }
    result.matched = true;
    result.steps.push(step(trigger, "message accepted"));

    // --- walk ------------------------------------------------------------
    let mut current = trigger;
    let mut steps = 0usize;

    loop {
        if steps >= MAX_STEPS {
            return fail(result, format!("stopped after {MAX_STEPS} steps"));
        }
        steps += 1;

        let outgoing = graph.outgoing(&current.id);
        let next: Option<&Node> = match current.kind.as_str() {
            "trigger" => next_node(graph, outgoing.first().copied()),

            "extract" => {
                let data: ExtractData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("extract data: {e}")),
                };
                let subject = match data.source.as_str() {
                    "sender" => &input.message.sender,
                    _ => &input.message.body,
                };
                let regex = match regex::RegexBuilder::new(&data.pattern)
                    .case_insensitive(data.flags.as_deref() == Some("i"))
                    .size_limit(1 << 20)
                    .build()
                {
                    Ok(regex) => regex,
                    Err(e) => return fail(result, format!("invalid pattern: {e}")),
                };

                let Some(captures) = regex.captures(subject) else {
                    result.outcome = "halted".into();
                    result.steps.push(step(current, "pattern did not match"));
                    return result;
                };

                let mut captured = Vec::new();
                for name in regex.capture_names().flatten() {
                    let value = captures.name(name).map(|m| m.as_str()).unwrap_or("");
                    result.variables.insert(name.to_string(), value.to_string());
                    captured.push(format!("{name}={value}"));
                }
                result
                    .steps
                    .push(step(current, &format!("captured {}", captured.join(", "))));
                next_node(graph, outgoing.first().copied())
            }

            "set_var" => {
                let data: SetVarData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("set_var data: {e}")),
                };
                let value = render(&data.value, &result.variables);
                result.variables.insert(data.name.clone(), value.clone());
                result
                    .steps
                    .push(step(current, &format!("{}={value}", data.name)));
                next_node(graph, outgoing.first().copied())
            }

            "condition" => {
                let data: ConditionData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("condition data: {e}")),
                };
                let left = render(&data.left, &result.variables);
                let right = render(data.right.as_deref().unwrap_or(""), &result.variables);
                let passed = match data.op.as_str() {
                    "equals" => left == right,
                    "not_equals" => left != right,
                    "contains" => left.contains(&right),
                    "matches" => regex::RegexBuilder::new(&right)
                        .size_limit(1 << 20)
                        .build()
                        .map(|re| re.is_match(&left))
                        .unwrap_or(false),
                    "exists" => !left.is_empty(),
                    other => return fail(result, format!("unknown operator '{other}'")),
                };
                let handle = if passed { "true" } else { "false" };
                result
                    .steps
                    .push(step(current, &format!("{handle} branch")));
                let edge = outgoing
                    .iter()
                    .find(|e| e.source_handle.as_deref() == Some(handle))
                    .copied();
                match edge {
                    Some(edge) => next_node(graph, Some(edge)),
                    None => {
                        result.outcome = "halted".into();
                        result.steps.push(step(current, "branch not connected"));
                        return result;
                    }
                }
            }

            "switch" => {
                let data: SwitchData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("switch data: {e}")),
                };
                let value = render(&data.value, &result.variables);
                let handle = data
                    .cases
                    .iter()
                    .position(|case| *case == value)
                    .map(|index| format!("case:{index}"))
                    .unwrap_or_else(|| "default".to_string());
                result
                    .steps
                    .push(step(current, &format!("{value} -> {handle}")));
                let edge = outgoing
                    .iter()
                    .find(|e| e.source_handle.as_deref() == Some(handle.as_str()))
                    .copied();
                match edge {
                    Some(edge) => next_node(graph, Some(edge)),
                    None => {
                        result.outcome = "halted".into();
                        result.steps.push(step(current, "branch not connected"));
                        return result;
                    }
                }
            }

            "delay" => {
                let data: DelayData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("delay data: {e}")),
                };
                let seconds = data.seconds.clamp(1, MAX_DELAY_SECONDS);
                result
                    .steps
                    .push(step(current, &format!("delay {seconds}s")));
                result.actions.push(Action::Delay { seconds });
                next_node(graph, outgoing.first().copied())
            }

            "webhook" => {
                let data: WebhookData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("webhook data: {e}")),
                };
                let url = render(&data.url, &result.variables);
                let body = render(&data.body, &result.variables);
                result
                    .steps
                    .push(step(current, &format!("would POST {url}")));
                result.actions.push(Action::Webhook { url, body });
                next_node(graph, outgoing.first().copied())
            }

            "send_sms" => {
                let data: SendSmsData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("send_sms data: {e}")),
                };
                let to = render(&data.to, &result.variables);
                let body = render(&data.body, &result.variables);
                if body.chars().count() > MAX_SMS_BODY_CHARS {
                    return fail(
                        result,
                        format!("rendered body exceeds {MAX_SMS_BODY_CHARS} characters"),
                    );
                }
                result
                    .steps
                    .push(step(current, &format!("would send to {to}")));
                result.actions.push(Action::SendSms { to, body });
                next_node(graph, outgoing.first().copied())
            }

            "stop" => {
                result.steps.push(step(current, "stop"));
                result.outcome = "delivered".into();
                return result;
            }

            other => return fail(result, format!("unknown node type '{other}'")),
        };

        match next {
            Some(node) => current = node,
            None => {
                result.outcome = "delivered".into();
                return result;
            }
        }
    }
}

fn next_node<'a>(graph: &'a FlowGraph, edge: Option<&Edge>) -> Option<&'a Node> {
    let edge = edge?;
    graph.node(&edge.target)
}

fn fail(mut result: RunResult, message: String) -> RunResult {
    result.outcome = "error".into();
    result.error = Some(message);
    result
}

fn step(node: &Node, detail: &str) -> Step {
    Step {
        node_id: node.id.clone(),
        kind: node.kind.clone(),
        detail: detail.to_string(),
    }
}

/* --------------------------------------------------------------- helpers */

fn matches_filter(value: &str, filter: Option<&Filter>) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    match filter.mode.as_str() {
        "any" => true,
        "exact" => filter.value.as_deref() == Some(value),
        "prefix" => filter
            .value
            .as_deref()
            .map(|v| value.starts_with(v))
            .unwrap_or(false),
        "keyword" => filter
            .value
            .as_deref()
            .map(|v| value.contains(v))
            .unwrap_or(false),
        "regex" => filter
            .value
            .as_deref()
            .and_then(|v| regex::RegexBuilder::new(v).size_limit(1 << 20).build().ok())
            .map(|re| re.is_match(value))
            .unwrap_or(false),
        _ => false,
    }
}

/// `{{name}}` substitution. `vars.name` is accepted as an alias, because that is
/// the spelling agent-authored graphs use. Unknown names resolve to an empty
/// string; the validator rejects them at save time, so this is a last-resort
/// guard.
fn render(template: &str, variables: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else {
            out.push_str(&rest[open..]);
            return out;
        };
        let raw = after[..close].trim();
        let name = raw.strip_prefix("vars.").unwrap_or(raw);
        out.push_str(variables.get(name).map(String::as_str).unwrap_or(""));
        rest = &after[close + 2..];
    }
    out.push_str(rest);
    out
}

/// Re-exported so a caller does not have to import `ir` to print the version.
pub fn flow_ir_version_value() -> &'static str {
    ir::IR_SCHEMA
}

/// Names in a template, for callers that render nothing but want to preview.
pub fn referenced_variables(template: &str) -> Vec<String> {
    template_names(template)
}

/// Capture groups a pattern declares, for the dashboard's variable menu.
pub fn declared_groups(pattern: &str) -> Vec<String> {
    named_groups(pattern)
}

/// Parse a value into the IR without validating it. Test and migration helper.
pub fn graph_from_value(value: Value) -> Result<FlowGraph, serde_json::Error> {
    serde_json::from_value(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graph(value: Value) -> FlowGraph {
        serde_json::from_value(value).unwrap()
    }

    fn code_flow() -> FlowGraph {
        graph(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "x1", "type": "extract", "data": {
                    "source": "body", "pattern": "CODE\\s+(?<code>\\d{6})" } },
                { "id": "c1", "type": "condition", "data": {
                    "left": "{{code}}", "op": "exists" } },
                { "id": "s1", "type": "send_sms", "data": {
                    "to": "{{sender}}", "body": "Your code is {{code}}" } },
                { "id": "e1", "type": "stop", "data": { "reason": "sent" } },
                { "id": "e2", "type": "stop", "data": { "reason": "no code" } }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "x1" },
                { "id": "b", "source": "x1", "target": "c1" },
                { "id": "c", "source": "c1", "target": "s1", "sourceHandle": "true" },
                { "id": "d", "source": "c1", "target": "e2", "sourceHandle": "false" },
                { "id": "e", "source": "s1", "target": "e1" }
            ]
        }))
    }

    fn run_with(graph: FlowGraph, sender: &str, body: &str) -> RunResult {
        run(&RunInput {
            graph,
            message: Message {
                sender: sender.into(),
                body: body.into(),
                received_at: Some(1_700_000_000_000),
            },
        })
    }

    #[test]
    fn extracts_and_replies() {
        let result = run_with(code_flow(), "+15551234567", "CODE 483920");
        assert!(result.matched);
        assert_eq!(result.outcome, "delivered");
        assert_eq!(result.variables.get("code").map(String::as_str), Some("483920"));
        assert_eq!(
            result.actions,
            vec![Action::SendSms {
                to: "+15551234567".into(),
                body: "Your code is 483920".into(),
            }]
        );
    }

    #[test]
    fn a_message_without_the_pattern_halts_without_sending() {
        let result = run_with(code_flow(), "+15551234567", "hello there");
        assert!(result.matched);
        assert_eq!(result.outcome, "halted");
        assert!(result.actions.is_empty());
    }

    #[test]
    fn trigger_filters_stop_the_flow() {
        let mut g = code_flow();
        g.nodes[0].data = json!({ "kind": "incoming", "body": { "mode": "keyword", "value": "CODE" } });

        let matched = run_with(g, "+1", "CODE 111111");
        assert_eq!(matched.outcome, "delivered");

        let filtered = run_with(code_flow_with_prefix(), "+1", "hello");
        assert!(!filtered.matched);
        assert_eq!(filtered.outcome, "filtered");
        assert!(filtered.actions.is_empty());
    }

    fn code_flow_with_prefix() -> FlowGraph {
        let mut g = code_flow();
        g.nodes[0].data = json!({ "kind": "incoming", "body": { "mode": "prefix", "value": "CODE" } });
        g
    }

    #[test]
    fn condition_false_branch_skips_the_send() {
        let g = graph(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "c1", "type": "condition", "data": {
                    "left": "{{body}}", "op": "equals", "right": "STOP" } },
                { "id": "s1", "type": "send_sms", "data": { "to": "{{sender}}", "body": "bye" } },
                { "id": "e1", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "c1" },
                { "id": "b", "source": "c1", "target": "s1", "sourceHandle": "true" },
                { "id": "c", "source": "c1", "target": "e2", "sourceHandle": "false" },
                { "id": "d", "source": "s1", "target": "e1" }
            ]
        }));

        let stopped = run_with(g, "+1", "STOP");
        assert_eq!(
            stopped.actions,
            vec![Action::SendSms { to: "+1".into(), body: "bye".into() }]
        );

        let g = graph(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "c1", "type": "condition", "data": {
                    "left": "{{body}}", "op": "equals", "right": "STOP" } },
                { "id": "s1", "type": "send_sms", "data": { "to": "{{sender}}", "body": "bye" } },
                { "id": "e1", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "c1" },
                { "id": "b", "source": "c1", "target": "s1", "sourceHandle": "true" },
                { "id": "c", "source": "c1", "target": "e2", "sourceHandle": "false" },
                { "id": "d", "source": "s1", "target": "e1" }
            ]
        }));
        let other = run_with(g, "+1", "hello");
        assert_eq!(other.outcome, "delivered");
        assert!(other.actions.is_empty());
    }

    #[test]
    fn templates_render_unknown_names_as_empty() {
        let mut vars = BTreeMap::new();
        vars.insert("code".to_string(), "42".to_string());
        assert_eq!(render("x={{code}} y={{nope}}", &vars), "x=42 y=");
        assert_eq!(render("no placeholders", &vars), "no placeholders");
        assert_eq!(render("broken {{code", &vars), "broken {{code");
    }

    #[test]
    fn invalid_graphs_return_errors_not_panics() {
        let empty = run_with(
            graph(json!({ "nodes": [], "edges": [] })),
            "+1",
            "x",
        );
        assert_eq!(empty.outcome, "no_trigger");
        assert!(empty.error.is_some());

        let unknown = graph(json!({
            "nodes": [{ "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                      { "id": "z", "type": "nope", "data": {} }],
            "edges": [{ "id": "a", "source": "t1", "target": "z" }]
        }));
        let result = run_with(unknown, "+1", "x");
        assert_eq!(result.outcome, "error");
        assert!(result.error.unwrap().contains("unknown node type"));
    }

    #[test]
    fn case_insensitive_patterns_work() {
        let g = graph(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "x1", "type": "extract", "data": {
                    "source": "body", "pattern": "code\\s+(?<code>\\d+)", "flags": "i" } },
                { "id": "s1", "type": "send_sms", "data": { "to": "{{sender}}", "body": "{{code}}" } },
                { "id": "e1", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "x1" },
                { "id": "b", "source": "x1", "target": "s1" },
                { "id": "c", "source": "s1", "target": "e1" }
            ]
        }));
        let result = run_with(g, "+1", "Code 777");
        assert_eq!(
            result.actions,
            vec![Action::SendSms { to: "+1".into(), body: "777".into() }]
        );
    }

    #[test]
    fn step_budget_prevents_a_cycle_from_hanging() {
        let g = graph(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "x1", "type": "extract", "data": {
                    "source": "body", "pattern": "(?<all>.*)" } }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "x1" },
                { "id": "b", "source": "x1", "target": "x1" }
            ]
        }));
        let result = run_with(g, "+1", "loop");
        assert_eq!(result.outcome, "error");
    }

    /* ---- the four kinds v2 added ------------------------------------- */

    fn v2_flow() -> FlowGraph {
        graph(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "x1", "type": "extract", "data": {
                    "source": "body", "pattern": "amount (?<amount>[0-9]+)" } },
                { "id": "v1", "type": "set_var", "data": {
                    "name": "note", "value": "amount={{vars.amount}}" } },
                { "id": "w1", "type": "switch", "data": {
                    "value": "{{amount}}", "cases": ["100", "200"] } },
                { "id": "d1", "type": "delay", "data": { "seconds": 30 } },
                { "id": "h1", "type": "webhook", "data": {
                    "url": "https://example.test/hook", "body": "note={{note}}" } },
                { "id": "s1", "type": "send_sms", "data": {
                    "to": "{{sender}}", "body": "{{note}}" } },
                { "id": "e1", "type": "stop", "data": {} },
                { "id": "e2", "type": "stop", "data": {} },
                { "id": "e3", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "x1" },
                { "id": "b", "source": "x1", "target": "v1" },
                { "id": "c", "source": "v1", "target": "w1" },
                { "id": "d", "source": "w1", "target": "d1", "sourceHandle": "case:0" },
                { "id": "e", "source": "w1", "target": "e2", "sourceHandle": "case:1" },
                { "id": "f", "source": "w1", "target": "e3", "sourceHandle": "default" },
                { "id": "g", "source": "d1", "target": "h1" },
                { "id": "h", "source": "h1", "target": "s1" },
                { "id": "i", "source": "s1", "target": "e1" }
            ]
        }))
    }

    #[test]
    fn set_var_switch_delay_and_webhook_run_in_order() {
        let result = run_with(v2_flow(), "+8801000000000", "amount 100");
        assert_eq!(result.outcome, "delivered");
        assert_eq!(result.variables.get("note").map(String::as_str), Some("amount=100"));
        assert_eq!(
            result.actions,
            vec![
                Action::Delay { seconds: 30 },
                Action::Webhook {
                    url: "https://example.test/hook".into(),
                    body: "note=amount=100".into(),
                },
                Action::SendSms {
                    to: "+8801000000000".into(),
                    body: "amount=100".into(),
                },
            ]
        );
    }

    #[test]
    fn switch_falls_through_to_default() {
        let result = run_with(v2_flow(), "+8801000000000", "amount 999");
        assert_eq!(result.outcome, "delivered");
        assert!(result.actions.is_empty(), "the default branch is a stop");
        assert_eq!(
            result.steps.last().map(|step| step.node_id.as_str()),
            Some("e3")
        );
    }

    /* ---- the IR itself ----------------------------------------------- */

    fn validate(value: Value) -> Result<FlowGraph, Vec<Issue>> {
        ir::validate(&value)
    }

    #[test]
    fn a_valid_graph_gets_a_layout_for_every_node() {
        let canonical = validate(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "s1", "type": "send_sms", "data": { "to": "{{sender}}", "body": "hi" } },
                { "id": "e1", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "s1" },
                { "id": "b", "source": "s1", "target": "e1" }
            ]
        }))
        .expect("valid graph");

        let layout = canonical.ui_layout.expect("layout is always computed");
        assert_eq!(layout.algorithm, ir::LAYOUT_ALGORITHM);
        assert_eq!(layout.positions.len(), 3);
        // Ranks become columns, so the flow reads left to right.
        assert_eq!(layout.positions["t1"], Position { x: 0.0, y: 0.0 });
        assert_eq!(layout.positions["s1"].x, 280.0);
        assert_eq!(layout.positions["e1"].x, 560.0);
    }

    #[test]
    fn a_cycle_is_refused_with_an_edge_and_a_node() {
        let issues = validate(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "s1", "type": "send_sms", "data": { "to": "{{sender}}", "body": "a" } },
                { "id": "s2", "type": "send_sms", "data": { "to": "{{sender}}", "body": "b" } }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "s1" },
                { "id": "b", "source": "s1", "target": "s2" },
                { "id": "c", "source": "s2", "target": "s1" }
            ]
        }))
        .expect_err("a cycle must be refused");

        let message = issues
            .iter()
            .map(|issue| format!("{} {}", issue.path, issue.message))
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(message.contains("cycle"), "{message}");
        assert!(message.contains("s1"), "the cycle must name a node: {message}");
    }

    #[test]
    fn a_variable_bound_on_only_one_branch_is_refused() {
        let issues = validate(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "c1", "type": "condition", "data": {
                    "left": "{{body}}", "op": "contains", "right": "amount" } },
                { "id": "x1", "type": "extract", "data": {
                    "source": "body", "pattern": "amount (?<amount>[0-9]+)" } },
                { "id": "s1", "type": "send_sms", "data": {
                    "to": "{{sender}}", "body": "{{amount}}" } },
                { "id": "e1", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "c1" },
                { "id": "b", "source": "c1", "target": "x1", "sourceHandle": "true" },
                { "id": "c", "source": "c1", "target": "s1", "sourceHandle": "false" },
                { "id": "d", "source": "x1", "target": "s1" },
                { "id": "e", "source": "s1", "target": "e1" }
            ]
        }))
        .expect_err("{{amount}} is not bound on every path");

        assert!(
            issues.iter().any(|issue| issue.message.contains("not bound on every path")),
            "{issues:?}"
        );
    }

    #[test]
    fn a_variable_nobody_binds_is_refused_with_its_name() {
        let issues = validate(json!({
            "nodes": [
                { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                { "id": "s1", "type": "send_sms", "data": {
                    "to": "{{sender}}", "body": "{{vars.amount}}" } },
                { "id": "e1", "type": "stop", "data": {} }
            ],
            "edges": [
                { "id": "a", "source": "t1", "target": "s1" },
                { "id": "b", "source": "s1", "target": "e1" }
            ]
        }))
        .expect_err("an unbound variable must be refused");

        assert!(
            issues.iter().any(|issue| issue.message.contains("never bound") && issue.message.contains("amount")),
            "{issues:?}"
        );
    }

    #[test]
    fn the_shared_vectors_agree_with_this_validator() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-support/flow-ir-vectors.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let vectors: Value = serde_json::from_str(&text).expect("vectors are JSON");
        let cases = vectors.as_array().expect("vectors are an array");
        assert!(cases.len() >= 8, "the vector file is the shared contract");

        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
            let expect_ok = case.get("ok").and_then(Value::as_bool).expect("ok");
            let graph = case.get("graph").expect("graph");
            let outcome = ir::validate(graph);
            match (expect_ok, &outcome) {
                (true, Ok(_)) => {}
                (true, Err(issues)) => panic!("{name}: expected valid, got {issues:?}"),
                (false, Ok(_)) => panic!("{name}: expected refused, got a valid graph"),
                (false, Err(issues)) => {
                    if let Some(contains) = case.get("contains").and_then(Value::as_str) {
                        let joined = issues
                            .iter()
                            .map(|issue| format!("{} {}", issue.path, issue.message))
                            .collect::<Vec<_>>()
                            .join(" | ");
                        assert!(
                            joined.contains(contains),
                            "{name}: expected an issue containing {contains:?}, got {joined}"
                        );
                    }
                }
            }
        }
    }
}

