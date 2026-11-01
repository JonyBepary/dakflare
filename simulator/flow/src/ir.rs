//! Canonical Flow IR v2 — the one schema every runtime reads.
//!
//! Before this module there were three opinions about what a flow is: the Worker's
//! validator (`worker/src/lib/workflow.ts`), the dashboard's editor, and this
//! interpreter. They agreed by coincidence and drifted by accident. The IR is now
//! a document with a version (`dakflare.flow/v2`), one validator per runtime, and a
//! shared vector file (`test-support/flow-ir-vectors.json`) that both are tested
//! against so "they agree" is evidence rather than a hope.
//!
//! ## The nine node kinds
//!
//! ```text
//! trigger    entry: sender/body filters
//! extract    regex capture groups -> variables
//! set_var    assign a rendered template to a variable
//! condition  two-way branch on one comparison
//! switch     n-way branch on a value, plus a default
//! delay      ask the caller to wait, then continue
//! webhook    ask the caller to POST, then continue
//! send_sms   ask the caller to send, then continue
//! stop       terminal
//! ```
//!
//! The interpreter is pure: `delay` and `webhook` and `send_sms` are ACTIONS the
//! caller performs in order, not effects this crate has. That is what lets the
//! same graph run on the phone, in the Worker's WASM fallback, and in a
//! deterministic trace without a clock or a network.
//!
//! ## Typed edges
//!
//! An edge carries a `sourceHandle` only when its source branches:
//!
//! ```text
//! condition -> "true" | "false"
//! switch    -> "case:0" | "case:1" | ... | "default"
//! everything else -> no handle
//! ```
//!
//! ## Layout is data, not paint
//!
//! `ui_layout` is optional. An agent that authors a graph writes nodes and edges
//! and nothing else; `layout()` ranks each node by its longest distance from the
//! trigger and places it from that rank and its sibling index. The algorithm is
//! named (`rank-v1`) and is deterministic, so the same graph produces the same
//! coordinates here, in the dashboard, and on the handset, and the canvas does not
//! jump when a graph is re-saved.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const IR_SCHEMA: &str = "dakflare.flow/v2";
pub const LAYOUT_ALGORITHM: &str = "rank-v1";

/// Bounds, shared with the Worker's copy so both refuse the same document.
pub const MAX_NODES: usize = 200;
pub const MAX_EDGES: usize = 400;
pub const MAX_ISSUES: usize = 50;
pub const MAX_STEPS: usize = 50;
pub const MAX_SMS_BODY_CHARS: usize = 4_096;
pub const MAX_SMS_TO_CHARS: usize = 32;
pub const MAX_DELAY_SECONDS: i64 = 300;
pub const MAX_TEMPLATE_CHARS: usize = 2_048;

const COL_GAP: f64 = 280.0;
const ROW_GAP: f64 = 160.0;

/// The kinds, in the order the palette shows them.
pub const NODE_KINDS: [&str; 9] = [
    "trigger",
    "extract",
    "set_var",
    "condition",
    "switch",
    "delay",
    "webhook",
    "send_sms",
    "stop",
];

/// Names a template may always use, because the interpreter binds them before
/// the first node runs.
pub const BUILTIN_VARIABLES: [&str; 3] = ["sender", "body", "received_at"];

/* ------------------------------------------------------------------ types */

/// A canvas coordinate.
///
/// `f64`, not an integer, because the dashboard's canvas stores what the pointer
/// gave it and a v6.0 row can hold `123.45`. Rounding happens in the canonical
/// form, but the TYPE has to tolerate a legacy document, or the phone refuses to
/// parse a flow the edge still serves.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
    /// Legacy carriers. v2 keeps positions in `ui_layout`, but a v1 document
    /// still in flight may carry them here; `from_legacy` folds them in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "sourceHandle", default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiLayout {
    pub algorithm: String,
    pub positions: BTreeMap<String, Position>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowGraph {
    #[serde(default = "default_schema")]
    pub schema: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_layout: Option<UiLayout>,
}

fn default_schema() -> String {
    IR_SCHEMA.to_string()
}

impl FlowGraph {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|node| node.id == id)
    }

    pub fn outgoing(&self, id: &str) -> Vec<&Edge> {
        self.edges.iter().filter(|edge| edge.source == id).collect()
    }
}

/* ----------------------------------------------------------------- issues */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    /// `nodes[2].data.pattern`, or `""` for the document itself.
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct Issues(Vec<Issue>);

impl Issues {
    fn new() -> Self {
        Issues(Vec::new())
    }
    fn push(&mut self, path: impl Into<String>, message: impl Into<String>) {
        if self.0.len() < MAX_ISSUES {
            self.0.push(Issue {
                path: path.into(),
                message: message.into(),
            });
        }
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn into_vec(self) -> Vec<Issue> {
        self.0
    }
}

pub type Validation = Result<FlowGraph, Vec<Issue>>;

/* ------------------------------------------------------------- node data */

/// The data of each kind, as the validator reads it. `serde(default)` everywhere
/// so a missing key is a validation issue with a path, not a deserialize error
/// without one.
#[derive(Debug, Clone, Default, Deserialize)]
struct TriggerData {
    #[serde(default)]
    sender: Option<Filter>,
    #[serde(default)]
    body: Option<Filter>,
}

#[derive(Debug, Clone, Deserialize)]
struct Filter {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default)]
    value: Option<String>,
}

fn default_mode() -> String {
    "any".to_string()
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ExtractData {
    #[serde(default = "default_source")]
    source: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    flags: Option<String>,
}

fn default_source() -> String {
    "body".to_string()
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SetVarData {
    #[serde(default)]
    name: String,
    #[serde(default)]
    value: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ConditionData {
    #[serde(default)]
    left: String,
    #[serde(default)]
    op: String,
    #[serde(default)]
    right: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SwitchData {
    #[serde(default)]
    value: String,
    #[serde(default)]
    cases: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DelayData {
    #[serde(default)]
    seconds: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WebhookData {
    #[serde(default)]
    url: String,
    #[serde(default)]
    body: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SendSmsData {
    #[serde(default)]
    to: String,
    #[serde(default)]
    body: String,
}

/* --------------------------------------------------------------- grammar */

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A variable name: a Java identifier capped at 32 characters, matching the
/// capture-group grammar so `set_var` and `extract` cannot disagree.
pub fn valid_variable_name(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    value.len() <= 32 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Named capture groups, scanned rather than regexed so `\(?<x>` and `[(?<x>)]`
/// are inert text. Mirrors `namedGroupNames` in the Worker's validator.
pub fn named_groups(pattern: &str) -> Vec<String> {
    let bytes = pattern.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut in_class = false;

    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'[' => {
                in_class = true;
                i += 1;
            }
            b']' => {
                in_class = false;
                i += 1;
            }
            b'(' if !in_class => {
                // `(?<name>` but not lookbehind `(?<=` / `(?<!`
                if i + 3 < bytes.len()
                    && bytes[i + 1] == b'?'
                    && bytes[i + 2] == b'<'
                    && bytes[i + 3] != b'='
                    && bytes[i + 3] != b'!'
                {
                    let start = i + 3;
                    let mut end = start;
                    while end < bytes.len() && bytes[end] != b'>' {
                        end += 1;
                    }
                    if end < bytes.len() {
                        out.push(pattern[start..end].to_string());
                        i = end;
                    }
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    out
}

/// `{{ name }}` references in a template, with `vars.` accepted as an alias.
pub fn template_names(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else { break };
        let raw = after[..close].trim();
        let name = raw.strip_prefix("vars.").unwrap_or(raw);
        if !name.is_empty() {
            names.push(name.to_string());
        }
        rest = &after[close + 2..];
    }
    names
}

/* ------------------------------------------------------------- validation */

/// Validate a document and return its canonical form.
///
/// The canonical form drops unknown node/edge keys, folds legacy `position` into
/// `ui_layout`, and stamps the schema version. It never throws and never panics
/// on hostile input.
pub fn validate(raw: &Value) -> Validation {
    let mut issues = Issues::new();

    let Some(object) = raw.as_object() else {
        issues.push("", "graph must be an object");
        return Err(issues.into_vec());
    };

    let nodes_raw = object.get("nodes");
    let edges_raw = object.get("edges");
    let Some(nodes_array) = nodes_raw.and_then(Value::as_array) else {
        issues.push("nodes", "must be an array");
        return Err(issues.into_vec());
    };
    let Some(edges_array) = edges_raw.and_then(Value::as_array) else {
        issues.push("edges", "must be an array");
        return Err(issues.into_vec());
    };

    if nodes_array.len() > MAX_NODES {
        issues.push("nodes", format!("must contain at most {MAX_NODES} nodes"));
    }
    if edges_array.len() > MAX_EDGES {
        issues.push("edges", format!("must contain at most {MAX_EDGES} edges"));
    }

    /* ---- nodes -------------------------------------------------------- */
    let mut nodes: Vec<Node> = Vec::new();
    let mut kinds: HashMap<String, String> = HashMap::new();
    let mut seen_nodes: HashMap<String, usize> = HashMap::new();
    let mut group_owner: HashMap<String, usize> = HashMap::new();
    // A document that already carries a position for every node is one somebody
    // arranged by hand. Those numbers win over the computed layout, which is the
    // same rule as the Worker's copy: re-saving a canvas must not reflow it.
    let mut legacy_positions: BTreeMap<String, Position> = BTreeMap::new();
    // name -> the node index that binds it, for duplicate detection.
    let mut bound_names: HashMap<String, usize> = HashMap::new();
    // Every template, checked after all nodes are known.
    let mut templates: Vec<(String, usize)> = Vec::new();

    for (index, value) in nodes_array.iter().enumerate() {
        let path = format!("nodes[{index}]");
        let Some(node) = value.as_object() else {
            issues.push(path, "must be an object");
            continue;
        };

        let id = match node.get("id").and_then(Value::as_str) {
            Some(id) if valid_id(id) => {
                if let Some(previous) = seen_nodes.get(id) {
                    issues.push(
                        format!("{path}.id"),
                        format!("duplicate node id '{id}' (also used by nodes[{previous}])"),
                    );
                } else {
                    seen_nodes.insert(id.to_string(), index);
                }
                id.to_string()
            }
            _ => {
                issues.push(format!("{path}.id"), "must match ^[A-Za-z0-9_-]{1,64}$");
                String::new()
            }
        };

        let kind = match node.get("type").and_then(Value::as_str) {
            Some(kind) if NODE_KINDS.contains(&kind) => kind.to_string(),
            _ => {
                issues.push(
                    format!("{path}.type"),
                    format!("must be one of {}", NODE_KINDS.join(", ")),
                );
                continue;
            }
        };

        let data = node.get("data").cloned().unwrap_or(Value::Object(Default::default()));

        // Per-kind data. Each branch records what it binds and which templates it
        // contains; a node that fails here still contributes its id/kind so the
        // structural checks report against a consistent graph.
        match kind.as_str() {
            "trigger" => {
                let parsed: TriggerData = serde_json::from_value(data.clone()).unwrap_or_default();
                if node.get("data").and_then(|d| d.get("kind")).and_then(Value::as_str) != Some("incoming")
                {
                    issues.push(format!("{path}.data.kind"), "must be 'incoming'");
                }
                if let Some(filter) = &parsed.sender {
                    check_filter(filter, &format!("{path}.data.sender"), &["any", "exact", "prefix", "regex"], &mut issues);
                }
                if let Some(filter) = &parsed.body {
                    check_filter(filter, &format!("{path}.data.body"), &["any", "keyword", "regex"], &mut issues);
                }
            }
            "extract" => {
                let parsed: ExtractData = serde_json::from_value(data.clone()).unwrap_or_default();
                if parsed.source != "body" && parsed.source != "sender" {
                    issues.push(format!("{path}.data.source"), "must be 'body' or 'sender'");
                }
                if let Some(flags) = &parsed.flags {
                    if flags != "" && flags != "i" {
                        issues.push(format!("{path}.data.flags"), "must be '' or 'i'");
                    }
                }
                if parsed.pattern.is_empty() {
                    issues.push(format!("{path}.data.pattern"), "must be a string");
                } else {
                    if parsed.pattern.contains("(?P<") {
                        issues.push(
                            format!("{path}.data.pattern"),
                            "use (?<name>...); (?P<name>...) is not supported",
                        );
                    }
                    if let Err(error) = regex::RegexBuilder::new(&parsed.pattern)
                        .case_insensitive(parsed.flags.as_deref() == Some("i"))
                        .size_limit(1 << 20)
                        .build()
                    {
                        issues.push(
                            format!("{path}.data.pattern"),
                            format!("regex rejected: {error}"),
                        );
                    }
                    let names = named_groups(&parsed.pattern);
                    if names.is_empty() {
                        issues.push(
                            format!("{path}.data.pattern"),
                            "must declare at least one named group, e.g. (?<order>[0-9]+)",
                        );
                    }
                    for name in names {
                        if !valid_variable_name(&name) {
                            issues.push(
                                format!("{path}.data.pattern"),
                                format!("invalid capture group name '{name}'"),
                            );
                            continue;
                        }
                        if BUILTIN_VARIABLES.contains(&name.as_str()) {
                            issues.push(
                                format!("{path}.data.pattern"),
                                format!("capture group '{name}' is reserved"),
                            );
                            continue;
                        }
                        if let Some(owner) = group_owner.get(&name) {
                            issues.push(
                                format!("{path}.data.pattern"),
                                format!(
                                    "duplicate capture group '{name}' (already declared at nodes[{owner}].data.pattern)"
                                ),
                            );
                            continue;
                        }
                        group_owner.insert(name.clone(), index);
                        bound_names.insert(name, index);
                    }
                }
            }
            "set_var" => {
                let parsed: SetVarData = serde_json::from_value(data.clone()).unwrap_or_default();
                if !valid_variable_name(&parsed.name) {
                    issues.push(
                        format!("{path}.data.name"),
                        "must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$",
                    );
                } else if BUILTIN_VARIABLES.contains(&parsed.name.as_str()) {
                    issues.push(
                        format!("{path}.data.name"),
                        format!("'{}' is reserved", parsed.name),
                    );
                } else if let Some(owner) = bound_names.get(&parsed.name) {
                    issues.push(
                        format!("{path}.data.name"),
                        format!("'{0}' is already bound at nodes[{1}]", parsed.name, owner),
                    );
                } else {
                    bound_names.insert(parsed.name.clone(), index);
                }
                check_template(&parsed.value, &format!("{path}.data.value"), index, &mut templates, &mut issues);
            }
            "condition" => {
                let parsed: ConditionData = serde_json::from_value(data.clone()).unwrap_or_default();
                check_template(&parsed.left, &format!("{path}.data.left"), index, &mut templates, &mut issues);
                if !matches!(
                    parsed.op.as_str(),
                    "equals" | "not_equals" | "contains" | "matches" | "exists"
                ) {
                    issues.push(
                        format!("{path}.data.op"),
                        "must be one of equals, not_equals, contains, matches, exists",
                    );
                }
                if parsed.op != "exists" {
                    match &parsed.right {
                        Some(right) => {
                            check_template(right, &format!("{path}.data.right"), index, &mut templates, &mut issues);
                            if parsed.op == "matches" {
                                if let Err(error) = regex::RegexBuilder::new(right)
                                    .size_limit(1 << 20)
                                    .build()
                                {
                                    issues.push(
                                        format!("{path}.data.right"),
                                        format!("regex rejected: {error}"),
                                    );
                                }
                            }
                        }
                        None => issues.push(
                            format!("{path}.data.right"),
                            format!("is required for op '{}'", parsed.op),
                        ),
                    }
                }
            }
            "switch" => {
                let parsed: SwitchData = serde_json::from_value(data.clone()).unwrap_or_default();
                check_template(&parsed.value, &format!("{path}.data.value"), index, &mut templates, &mut issues);
                if parsed.cases.is_empty() {
                    issues.push(
                        format!("{path}.data.cases"),
                        "must list at least one case",
                    );
                }
                if parsed.cases.len() > 8 {
                    issues.push(format!("{path}.data.cases"), "must have at most 8 cases");
                }
                for (case_index, case) in parsed.cases.iter().enumerate() {
                    if case.is_empty() {
                        issues.push(
                            format!("{path}.data.cases[{case_index}]"),
                            "must not be empty",
                        );
                    }
                }
            }
            "delay" => {
                let parsed: DelayData = serde_json::from_value(data.clone()).unwrap_or_default();
                if parsed.seconds < 1 || parsed.seconds > MAX_DELAY_SECONDS {
                    issues.push(
                        format!("{path}.data.seconds"),
                        format!("must be between 1 and {MAX_DELAY_SECONDS}"),
                    );
                }
            }
            "webhook" => {
                let parsed: WebhookData = serde_json::from_value(data.clone()).unwrap_or_default();
                if !(parsed.url.starts_with("https://") || parsed.url.starts_with("http://127.0.0.1")) {
                    issues.push(
                        format!("{path}.data.url"),
                        "must be an https:// URL",
                    );
                }
                check_template(&parsed.url, &format!("{path}.data.url"), index, &mut templates, &mut issues);
                check_template(&parsed.body, &format!("{path}.data.body"), index, &mut templates, &mut issues);
            }
            "send_sms" => {
                let parsed: SendSmsData = serde_json::from_value(data.clone()).unwrap_or_default();
                if parsed.to.is_empty() {
                    issues.push(format!("{path}.data.to"), "is required and must not be empty");
                }
                if parsed.to.len() > MAX_SMS_TO_CHARS {
                    issues.push(
                        format!("{path}.data.to"),
                        format!("must be at most {MAX_SMS_TO_CHARS} characters"),
                    );
                }
                if parsed.body.is_empty() {
                    issues.push(format!("{path}.data.body"), "is required and must not be empty");
                }
                if parsed.body.len() > MAX_SMS_BODY_CHARS {
                    issues.push(
                        format!("{path}.data.body"),
                        format!("must be at most {MAX_SMS_BODY_CHARS} characters"),
                    );
                }
                check_template(&parsed.to, &format!("{path}.data.to"), index, &mut templates, &mut issues);
                check_template(&parsed.body, &format!("{path}.data.body"), index, &mut templates, &mut issues);
            }
            "stop" => {}
            _ => unreachable!("kind was checked against NODE_KINDS"),
        }

        if !id.is_empty() && seen_nodes.get(&id) == Some(&index) {
            kinds.insert(id.clone(), kind.clone());
        }
        let position = node.get("position").and_then(parse_position);
        if let (Some(position), false) = (position, id.is_empty()) {
            legacy_positions.insert(id.clone(), position);
        }
        nodes.push(Node {
            id,
            kind,
            data,
            position,
        });
    }

    /* ---- edges -------------------------------------------------------- */
    let mut edges: Vec<Edge> = Vec::new();
    let mut seen_edges: HashMap<String, usize> = HashMap::new();

    for (index, value) in edges_array.iter().enumerate() {
        let path = format!("edges[{index}]");
        let Some(edge) = value.as_object() else {
            issues.push(path, "must be an object");
            continue;
        };

        let id = match edge.get("id").and_then(Value::as_str) {
            Some(id) if valid_id(id) => {
                if let Some(previous) = seen_edges.get(id) {
                    issues.push(
                        format!("{path}.id"),
                        format!("duplicate edge id '{id}' (also used by edges[{previous}])"),
                    );
                } else {
                    seen_edges.insert(id.to_string(), index);
                }
                id.to_string()
            }
            _ => {
                issues.push(format!("{path}.id"), "must match ^[A-Za-z0-9_-]{1,64}$");
                String::new()
            }
        };

        let source = edge.get("source").and_then(Value::as_str).unwrap_or("");
        let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
        if source.is_empty() {
            issues.push(format!("{path}.source"), "must be a non-empty string");
        } else if !kinds.contains_key(source) {
            issues.push(format!("{path}.source"), format!("references unknown node '{source}'"));
        }
        if target.is_empty() {
            issues.push(format!("{path}.target"), "must be a non-empty string");
        } else if !kinds.contains_key(target) {
            issues.push(format!("{path}.target"), format!("references unknown node '{target}'"));
        }
        if !source.is_empty() && source == target {
            issues.push(format!("{path}.target"), "self-loop: source and target are the same node");
        }

        let handle = edge.get("sourceHandle").and_then(Value::as_str);
        match kinds.get(source).map(String::as_str) {
            Some("condition") => match handle {
                None => issues.push(
                    format!("{path}.sourceHandle"),
                    "is required when the source is a condition",
                ),
                Some(value) if value != "true" && value != "false" => issues.push(
                    format!("{path}.sourceHandle"),
                    "must be 'true' or 'false'",
                ),
                Some(_) => {}
            },
            Some("switch") => match handle {
                None => issues.push(
                    format!("{path}.sourceHandle"),
                    "is required when the source is a switch",
                ),
                Some(value) => {
                    let valid = value == "default"
                        || value
                            .strip_prefix("case:")
                            .and_then(|rest| rest.parse::<usize>().ok())
                            .is_some();
                    if !valid {
                        issues.push(
                            format!("{path}.sourceHandle"),
                            "must be 'case:<index>' or 'default'",
                        );
                    }
                }
            },
            Some(other) => {
                if handle.is_some() {
                    issues.push(
                        format!("{path}.sourceHandle"),
                        format!("is only allowed when the source branches (source is '{other}')"),
                    );
                }
            }
            None => {}
        }

        edges.push(Edge {
            id,
            source: source.to_string(),
            target: target.to_string(),
            source_handle: handle.map(str::to_string),
            label: edge.get("label").and_then(Value::as_str).map(str::to_string),
        });
    }

    if !issues.is_empty() {
        return Err(issues.into_vec());
    }

    /* ---- structure ---------------------------------------------------- */
    let mut graph = FlowGraph {
        schema: IR_SCHEMA.to_string(),
        nodes,
        edges,
        ui_layout: None,
    };
    check_structure(&graph, &mut issues);

    // Templates depend on the binding analysis below, so they are last.
    if issues.is_empty() {
        check_bindings(&graph, &templates, &mut issues);
    }

    if !issues.is_empty() {
        return Err(issues.into_vec());
    }

    let computed = layout(&graph);
    graph.ui_layout = Some(if legacy_positions.len() == graph.nodes.len() && !graph.nodes.is_empty() {
        UiLayout {
            algorithm: LAYOUT_ALGORITHM.to_string(),
            positions: legacy_positions,
        }
    } else {
        computed
    });
    Ok(graph)
}

fn parse_position(value: &Value) -> Option<Position> {
    let object = value.as_object()?;
    let x = object.get("x")?.as_f64()?;
    let y = object.get("y")?.as_f64()?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(Position {
        x: x.round(),
        y: y.round(),
    })
}

fn check_filter(filter: &Filter, path: &str, modes: &[&str], issues: &mut Issues) {
    if !modes.contains(&filter.mode.as_str()) {
        issues.push(
            format!("{path}.mode"),
            format!("must be one of {}", modes.join(", ")),
        );
    }
    if filter.mode != "any" && filter.value.as_deref().unwrap_or("").is_empty() {
        issues.push(format!("{path}.value"), "is required for this mode");
    }
    if filter.mode == "regex" {
        if let Some(value) = &filter.value {
            if let Err(error) = regex::RegexBuilder::new(value).size_limit(1 << 20).build() {
                issues.push(format!("{path}.value"), format!("regex rejected: {error}"));
            }
        }
    }
}

fn check_template(
    value: &str,
    path: &str,
    index: usize,
    templates: &mut Vec<(String, usize)>,
    issues: &mut Issues,
) {
    if value.len() > MAX_TEMPLATE_CHARS {
        issues.push(path, format!("must be at most {MAX_TEMPLATE_CHARS} characters"));
        return;
    }
    for name in template_names(value) {
        if !valid_variable_name(&name) {
            issues.push(path, format!("'{{{{{name}}}}}' is not a valid variable name"));
            continue;
        }
        templates.push((name, index));
    }
}

/* ------------------------------------------------------------- structure */

fn check_structure(graph: &FlowGraph, issues: &mut Issues) {
    let triggers: Vec<usize> = graph
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.kind == "trigger")
        .map(|(index, _)| index)
        .collect();

    if triggers.len() != 1 {
        issues.push(
            "nodes",
            format!(
                "graph must contain exactly one trigger node (found {})",
                triggers.len()
            ),
        );
    }

    for (index, node) in graph.nodes.iter().enumerate() {
        let path = format!("nodes[{index}]");
        let outs = graph.outgoing(&node.id);
        let ins: Vec<&Edge> = graph
            .edges
            .iter()
            .filter(|edge| edge.target == node.id)
            .collect();

        match node.kind.as_str() {
            "trigger" => {
                for edge in &ins {
                    issues.push(
                        format!(
                            "edges[{}].target",
                            graph.edges.iter().position(|e| e.id == edge.id).unwrap_or(0)
                        ),
                        "the trigger node must not have incoming edges",
                    );
                }
                if outs.len() != 1 {
                    issues.push(
                        path,
                        format!("trigger node must have exactly 1 outgoing edge (found {})", outs.len()),
                    );
                }
            }
            "condition" => {
                if outs.len() != 2 {
                    issues.push(
                        path.clone(),
                        format!("condition node must have exactly 2 outgoing edges (found {})", outs.len()),
                    );
                }
                let mut handles: BTreeSet<&str> = BTreeSet::new();
                for edge in &outs {
                    handles.insert(edge.source_handle.as_deref().unwrap_or(""));
                }
                if handles.len() != 2 || !handles.contains("true") || !handles.contains("false") {
                    issues.push(
                        path,
                        "condition node needs one 'true' and one 'false' outgoing edge",
                    );
                }
            }
            "switch" => {
                let cases: Vec<String> =
                    serde_json::from_value::<SwitchData>(node.data.clone())
                        .unwrap_or_default()
                        .cases;
                let expected = cases.len() + 1;
                if outs.len() != expected {
                    issues.push(
                        path.clone(),
                        format!(
                            "switch node with {} case(s) must have {} outgoing edges (one per case plus default), found {}",
                            cases.len(),
                            expected,
                            outs.len()
                        ),
                    );
                }
                let mut seen: BTreeSet<String> = BTreeSet::new();
                for edge in &outs {
                    let handle = edge.source_handle.clone().unwrap_or_default();
                    if !seen.insert(handle.clone()) {
                        issues.push(path.clone(), format!("duplicate branch handle '{handle}'"));
                    }
                    if let Some(rest) = handle.strip_prefix("case:") {
                        match rest.parse::<usize>() {
                            Ok(case_index) if case_index < cases.len() => {}
                            _ => issues.push(
                                path.clone(),
                                format!("branch handle '{handle}' names a case that does not exist"),
                            ),
                        }
                    } else if handle != "default" {
                        issues.push(path.clone(), format!("unknown branch handle '{handle}'"));
                    }
                }
                if !seen.contains("default") {
                    issues.push(path, "switch node needs a 'default' outgoing edge");
                }
            }
            "stop" => {
                if !outs.is_empty() {
                    issues.push(
                        path,
                        format!("stop node must not have outgoing edges (found {})", outs.len()),
                    );
                }
            }
            _ => {
                if outs.len() != 1 {
                    issues.push(
                        path,
                        format!(
                            "{} node must have exactly 1 outgoing edge (found {})",
                            node.kind,
                            outs.len()
                        ),
                    );
                }
            }
        }
    }

    if trigger_count(&graph.nodes) == 1 {
        check_acyclic(graph, issues);
        check_reachability(graph, issues);
    }
}

fn trigger_count(nodes: &[Node]) -> usize {
    nodes.iter().filter(|node| node.kind == "trigger").count()
}

/// Iterative DFS. Reports the edge that closes the cycle and the node it returns
/// to, because "cycle detected" without an id is a message an agent cannot act on.
fn check_acyclic(graph: &FlowGraph, issues: &mut Issues) {
    #[derive(Clone, Copy, PartialEq)]
    enum Colour {
        White,
        Grey,
        Black,
    }
    let mut colour: HashMap<&str, Colour> = HashMap::new();

    for node in &graph.nodes {
        if colour.get(node.id.as_str()).copied().unwrap_or(Colour::White) != Colour::White {
            continue;
        }
        colour.insert(&node.id, Colour::Grey);
        let mut stack: Vec<(&str, usize)> = vec![(&node.id, 0)];

        while let Some((id, cursor)) = stack.pop() {
            let outs = graph.outgoing(id);
            if cursor >= outs.len() {
                colour.insert(id, Colour::Black);
                continue;
            }
            stack.push((id, cursor + 1));
            let edge = outs[cursor];
            if edge.source == edge.target {
                continue;
            }
            match colour.get(edge.target.as_str()).copied().unwrap_or(Colour::White) {
                Colour::Grey => {
                    let edge_index = graph
                        .edges
                        .iter()
                        .position(|candidate| candidate.id == edge.id)
                        .unwrap_or(0);
                    issues.push(
                        format!("edges[{edge_index}]"),
                        format!(
                            "cycle detected: this edge returns to '{}', which is already on the path",
                            edge.target
                        ),
                    );
                    return;
                }
                Colour::White => {
                    colour.insert(&edge.target, Colour::Grey);
                    stack.push((&edge.target, 0));
                }
                Colour::Black => {}
            }
        }
    }
}

fn check_reachability(graph: &FlowGraph, issues: &mut Issues) {
    let Some(root) = graph.nodes.iter().find(|node| node.kind == "trigger") else {
        return;
    };
    let mut reached: HashSet<&str> = HashSet::new();
    let mut queue: Vec<&str> = vec![&root.id];
    reached.insert(&root.id);

    // `while`, not `for head in 0..len`: the range captures the length once, so
    // nodes discovered during the walk would never be visited. That bug made a
    // three-node chain report its last node as unreachable.
    let mut head = 0usize;
    while head < queue.len() {
        let id = queue[head];
        head += 1;
        for edge in graph.outgoing(id) {
            if edge.source == edge.target {
                continue;
            }
            if reached.insert(&edge.target) {
                queue.push(&edge.target);
            }
        }
    }

    for (index, node) in graph.nodes.iter().enumerate() {
        if !reached.contains(node.id.as_str()) {
            issues.push(
                format!("nodes[{index}]"),
                format!("node '{}' is not reachable from the trigger", node.id),
            );
        }
    }
}

/* -------------------------------------------------------------- bindings */

/// Which variables a node is guaranteed to have bound for its own templates.
fn bound_builtins() -> BTreeSet<String> {
    BUILTIN_VARIABLES.iter().map(|name| name.to_string()).collect()
}

/// The names a node binds for everything downstream of it.
fn binds(node: &Node) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    match node.kind.as_str() {
        "extract" => {
            if let Ok(data) = serde_json::from_value::<ExtractData>(node.data.clone()) {
                for name in named_groups(&data.pattern) {
                    out.insert(name);
                }
            }
        }
        "set_var" => {
            if let Ok(data) = serde_json::from_value::<SetVarData>(node.data.clone()) {
                if valid_variable_name(&data.name) {
                    out.insert(data.name);
                }
            }
        }
        _ => {}
    }
    out
}

/**
 * Forward dataflow: the variables DEFINITELY bound at a node are the intersection
 * of what every predecessor path guarantees.
 *
 * This is what refuses `{{amount}}` on a branch that never extracts it, which is
 * the failure an agent-authored graph makes most often: it reads a variable that
 * exists on the path it was thinking about and not on the other one.
 */
fn check_bindings(graph: &FlowGraph, templates: &[(String, usize)], issues: &mut Issues) {
    if templates.is_empty() {
        return;
    }

    // Topological order over a graph already proven acyclic and reachable.
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for node in &graph.nodes {
        remaining.insert(
            &node.id,
            graph
                .edges
                .iter()
                .filter(|edge| edge.target == node.id && edge.source != edge.target)
                .count(),
        );
    }
    let mut ready: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|node| remaining.get(node.id.as_str()).copied() == Some(0))
        .map(|node| node.id.as_str())
        .collect();
    ready.sort_unstable();

    let mut inbound: HashMap<&str, BTreeSet<String>> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();

    // `while`, for the same reason as `check_reachability`: `ready` grows.
    let mut head = 0usize;
    while head < ready.len() {
        let id = ready[head];
        head += 1;
        order.push(id);

        // in(n) = intersection over the OUT-set of every predecessor, where
        // out(p) = in(p) plus whatever p itself binds. The root starts from the
        // builtins, which the interpreter sets before the first node runs.
        let mut available = bound_builtins();
        let mut first = true;
        for edge in graph.edges.iter().filter(|edge| edge.target == id) {
            let mut from = inbound
                .get(edge.source.as_str())
                .cloned()
                .unwrap_or_else(bound_builtins);
            if let Some(source) = graph.node(&edge.source) {
                from.extend(binds(source));
            }
            if first {
                available = from;
                first = false;
            } else {
                available = available.intersection(&from).cloned().collect();
            }
        }
        inbound.insert(id, available);

        for edge in graph.outgoing(id) {
            if let Some(count) = remaining.get_mut(edge.target.as_str()) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    ready.push(&edge.target);
                }
            }
        }
    }

    for (name, index) in templates {
        let node_id = &graph.nodes[*index].id;
        let available = inbound.get(node_id.as_str()).cloned().unwrap_or_else(bound_builtins);
        if available.contains(name) {
            continue;
        }
        let bound_elsewhere = graph.nodes.iter().any(|node| binds(node).contains(name));
        let message = if bound_elsewhere {
            format!(
                "'{{{{{name}}}}}' is not bound on every path to this node: a branch reaches it without an extract or set_var that produces '{name}'"
            )
        } else {
            format!("'{{{{{name}}}}}' is never bound: no extract group or set_var produces '{name}'")
        };
        issues.push(format!("nodes[{index}].data"), message);
    }
}

/* ---------------------------------------------------------------- layout */

/**
 * Deterministic layout: rank by longest path from the entry, then place from the
 * rank and the sibling index.
 *
 * `x` comes from the rank, so the flow reads left to right. `y` comes from the
 * order within the rank, and that order is seeded by the predecessor order in the
 * rank above, so the drawing follows the branches instead of the alphabet.
 */
pub fn layout(graph: &FlowGraph) -> UiLayout {
    let mut rank: HashMap<&str, i32> = HashMap::new();
    let Some(root) = graph.nodes.iter().find(|node| node.kind == "trigger") else {
        return UiLayout {
            algorithm: LAYOUT_ALGORITHM.to_string(),
            positions: BTreeMap::new(),
        };
    };

    // Longest path from the root, computed in topological order.
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    for node in &graph.nodes {
        indegree.insert(
            &node.id,
            graph
                .edges
                .iter()
                .filter(|edge| edge.target == node.id && edge.source != edge.target)
                .count(),
        );
    }
    rank.insert(&root.id, 0);
    let mut queue: Vec<&str> = vec![&root.id];
    let mut head = 0;
    while head < queue.len() {
        let id = queue[head];
        head += 1;
        let current = rank.get(id).copied().unwrap_or(0);
        for edge in graph.outgoing(id) {
            if edge.source == edge.target {
                continue;
            }
            let candidate = current + 1;
            let entry = rank.entry(&edge.target).or_insert(0);
            if candidate > *entry {
                *entry = candidate;
            }
            if let Some(count) = indegree.get_mut(edge.target.as_str()) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    queue.push(&edge.target);
                }
            }
        }
    }

    // Bucket by rank, then order inside a rank by the median rank index of the
    // node's predecessors, falling back to id so the result is total.
    let mut buckets: BTreeMap<i32, Vec<&Node>> = BTreeMap::new();
    for node in &graph.nodes {
        let value = rank.get(node.id.as_str()).copied().unwrap_or(0);
        buckets.entry(value).or_default().push(node);
    }

    let mut positions: BTreeMap<String, Position> = BTreeMap::new();
    let mut previous_order: HashMap<&str, usize> = HashMap::new();

    for (column, (_, bucket)) in buckets.iter_mut().enumerate() {
        bucket.sort_by_key(|node| {
            let seed = graph
                .edges
                .iter()
                .filter(|edge| edge.target == node.id)
                .filter_map(|edge| previous_order.get(edge.source.as_str()).copied())
                .min()
                .unwrap_or(usize::MAX);
            (seed, node.id.clone())
        });
        for (row, node) in bucket.iter().enumerate() {
            previous_order.insert(&node.id, row);
            positions.insert(
                node.id.clone(),
                Position {
                    x: column as f64 * COL_GAP,
                    y: row as f64 * ROW_GAP,
                },
            );
        }
    }

    UiLayout {
        algorithm: LAYOUT_ALGORITHM.to_string(),
        positions,
    }
}

/* --------------------------------------------------------------- helpers */

/// Sort issues for a stable response: by path, then message.
pub fn sorted(mut issues: Vec<Issue>) -> Vec<Issue> {
    issues.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.message.cmp(&right.message))
    });
    issues
}
