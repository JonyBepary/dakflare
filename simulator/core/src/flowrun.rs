//! Device-side flow execution.
//!
//! The device is the primary engine: the SMS is already on the phone, so running
//! the graph there is instant and works offline. The Worker's WASM interpreter is
//! the fallback, and it must not repeat a run reported here.
//!
//! Reporting is per message and per flow version: `(local_id, flow_id, version)`.
//! A graph edited after the message arrived is a different flow, so v1 must not
//! suppress a legitimately different v2.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use dakflare_flow::{Action, Message, RunInput, run};

/// A flow fetched from the deployment.
#[derive(Debug, Clone, Deserialize)]
pub struct RemoteFlow {
    pub id: String,
    pub version: i64,
    pub graph: Value,
}

/// What the device reports back with the message it processed.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FlowRunReport {
    pub local_id: String,
    pub flow_id: String,
    pub flow_version: i64,
    pub outcome: String,
}

#[derive(Debug)]
pub struct LocalRun {
    /// Actions the device must perform (send SMS) — already templated.
    pub actions: Vec<Action>,
    pub reports: Vec<FlowRunReport>,
}

/// Run every applicable flow for one message.
///
/// A flow that fails to parse or execute is reported as `error` rather than
/// aborting the others: one bad graph must not stop automation for the device.
pub fn run_flows(flows: &[RemoteFlow], local_id: &str, sender: &str, body: &str) -> LocalRun {
    let mut actions = Vec::new();
    let mut reports = Vec::new();

    for flow in flows {
        let graph: dakflare_flow::FlowGraph = match serde_json::from_value(flow.graph.clone()) {
            Ok(graph) => graph,
            Err(_) => {
                reports.push(FlowRunReport {
                    local_id: local_id.to_string(),
                    flow_id: flow.id.clone(),
                    flow_version: flow.version,
                    outcome: "error".into(),
                });
                continue;
            }
        };

        let result = run(&RunInput {
            graph,
            message: Message {
                sender: sender.to_string(),
                body: body.to_string(),
                received_at: Some(now_ms()),
            },
        });

        reports.push(FlowRunReport {
            local_id: local_id.to_string(),
            flow_id: flow.id.clone(),
            flow_version: flow.version,
            outcome: result.outcome.clone(),
        });

        if result.matched && result.outcome == "delivered" {
            actions.extend(result.actions);
        }
    }

    LocalRun { actions, reports }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flow(id: &str, version: i64) -> RemoteFlow {
        RemoteFlow {
            id: id.into(),
            version,
            graph: json!({
                "nodes": [
                    { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                    { "id": "x1", "type": "extract", "data": {
                        "source": "body", "pattern": "CODE\\s+(?<code>\\d{6})" } },
                    { "id": "s1", "type": "send_sms", "data": {
                        "to": "{{sender}}", "body": "Your code is {{code}}" } },
                    { "id": "e1", "type": "stop", "data": {} }
                ],
                "edges": [
                    { "id": "a", "source": "t1", "target": "x1" },
                    { "id": "b", "source": "x1", "target": "s1" },
                    { "id": "c", "source": "s1", "target": "e1" }
                ]
            }),
        }
    }

    #[test]
    fn runs_locally_and_reports_the_version() {
        let result = run_flows(&[flow("wf_a", 3)], "sim-1", "+15551230000", "CODE 483920");

        assert_eq!(result.actions.len(), 1);
        assert_eq!(
            result.actions[0],
            Action::SendSms {
                to: "+15551230000".into(),
                body: "Your code is 483920".into(),
            }
        );
        assert_eq!(result.reports.len(), 1);
        assert_eq!(result.reports[0].flow_id, "wf_a");
        assert_eq!(result.reports[0].flow_version, 3);
        assert_eq!(result.reports[0].outcome, "delivered");
    }

    #[test]
    fn a_non_matching_message_reports_without_actions() {
        let result = run_flows(&[flow("wf_a", 1)], "sim-2", "+1", "hello");
        assert!(result.actions.is_empty());
        assert_eq!(result.reports[0].outcome, "halted");
    }

    #[test]
    fn one_bad_graph_does_not_stop_the_others() {
        let broken = RemoteFlow {
            id: "wf_bad".into(),
            version: 1,
            graph: json!({ "nodes": "not-an-array" }),
        };
        let result = run_flows(&[broken, flow("wf_good", 2)], "sim-3", "+1", "CODE 111111");

        assert_eq!(result.reports.len(), 2);
        assert_eq!(result.reports[0].outcome, "error");
        assert_eq!(result.reports[1].outcome, "delivered");
        assert_eq!(result.actions.len(), 1);
    }
}
