//! Deterministic flow interpreter.
//!
//! Pure by design: a graph plus a message in, a list of actions out. No clock, no
//! network, no randomness — so the same graph produces the same result on the
//! desktop simulator, on Android, and in the Worker's WASM fallback. The caller
//! performs the actions.
//!
//! The graph shape is the one the dashboard canvas produces and the Worker
//! validates:
//!
//! ```text
//! trigger -> extract -> condition -true->  send_sms -> stop
//!                                  \-false-> stop
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_STEPS: usize = 50;

/* ------------------------------------------------------------------ input */

#[derive(Debug, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "sourceHandle", default)]
    pub source_handle: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    pub sender: String,
    pub body: String,
    #[serde(default)]
    pub received_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RunInput {
    pub graph: Graph,
    pub message: Message,
}

/* ----------------------------------------------------------------- output */

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    SendSms { to: String, body: String },
}

#[derive(Debug, Serialize)]
pub struct Step {
    pub node_id: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub matched: bool,
    pub outcome: String,
    pub actions: Vec<Action>,
    pub variables: BTreeMap<String, String>,
    pub steps: Vec<Step>,
    pub error: Option<String>,
}

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
struct ConditionData {
    left: String,
    op: String,
    #[serde(default)]
    right: Option<String>,
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
    let trigger = match graph.nodes.iter().find(|n| n.kind == "trigger") {
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

        let outgoing: Vec<&Edge> = graph.edges.iter().filter(|e| e.source == current.id).collect();

        let next: Option<&Node> = match current.kind.as_str() {
            "trigger" => {
                outline(&mut result, current, "forward");
                next_node(graph, outgoing.first().copied())
            }
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
                    "matches" => regex::Regex::new(&right)
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
            "send_sms" => {
                let data: SendSmsData = match serde_json::from_value(current.data.clone()) {
                    Ok(data) => data,
                    Err(e) => return fail(result, format!("send_sms data: {e}")),
                };
                let to = render(&data.to, &result.variables);
                let body = render(&data.body, &result.variables);
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

fn next_node<'a>(graph: &'a Graph, edge: Option<&Edge>) -> Option<&'a Node> {
    let edge = edge?;
    graph.nodes.iter().find(|n| n.id == edge.target)
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

fn outline(result: &mut RunResult, node: &Node, detail: &str) {
    result.steps.push(step(node, detail));
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
            .and_then(|v| regex::Regex::new(v).ok())
            .map(|re| re.is_match(value))
            .unwrap_or(false),
        _ => false,
    }
}

/// `{{name}}` substitution. Unknown names resolve to an empty string; the graph
/// validator rejects them at save time, so this is only a last-resort guard.
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
        let name = after[..close].trim();
        out.push_str(variables.get(name).map(String::as_str).unwrap_or(""));
        rest = &after[close + 2..];
    }
    out.push_str(rest);
    out
}

/* ----------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graph(value: Value) -> Graph {
        serde_json::from_value(value).unwrap()
    }

    fn code_flow() -> Graph {
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

    fn run_with(graph: Graph, sender: &str, body: &str) -> RunResult {
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

    fn code_flow_with_prefix() -> Graph {
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
                { "id": "e1", "type": "stop", "data": {} },
                { "id": "e2", "type": "stop", "data": {} }
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
                { "id": "e1", "type": "stop", "data": {} },
                { "id": "e2", "type": "stop", "data": {} }
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
}
