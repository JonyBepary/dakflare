/**
 * A client-side preview of what a workflow would do.
 *
 * There is no execution engine in the Worker yet, so this interpreter exists
 * purely to make the canvas legible: it walks the same document the editor saves,
 * applies the trigger filters, extracts named groups, evaluates branches and
 * collects outgoing SMS. It never sends anything and it is deliberately strict
 * about stopping — the moment a step cannot produce a value, the trace says so
 * instead of inventing one.
 */

import type { FlowEdge, FlowNode } from './graph';
import { extractGroupNames, nodeData } from './graph';
import type {
	ConditionData,
	ExtractData,
	SendSmsData,
	StopData,
	TriggerData
} from '$lib/types';

export interface SimulationInput {
	sender: string;
	body: string;
}

export interface SimulationSms {
	nodeId: string;
	to: string;
	body: string;
}

export interface SimulationStep {
	nodeId: string;
	edgeId?: string;
	tone: 'ok' | 'muted' | 'warn' | 'danger';
	text: string;
}

export interface SimulationResult {
	entered: boolean;
	outcome: 'delivered' | 'filtered' | 'halted' | 'error';
	summary: string;
	visitedNodes: string[];
	visitedEdges: string[];
	variables: Record<string, string>;
	sms: SimulationSms[];
	steps: SimulationStep[];
	warnings: string[];
}

const MAX_STEPS = 200;

function safeRegex(pattern: string, flags: string): RegExp | null {
	try {
		return new RegExp(pattern, flags);
	} catch {
		return null;
	}
}

function matchesMode(value: string, mode: string | undefined, target: string | undefined): boolean {
	if (!mode || mode === 'any') return true;
	if (mode === 'keyword') return value.includes(target ?? '');
	if (!target) return false;
	if (mode === 'exact') return value === target;
	if (mode === 'prefix') return value.startsWith(target);
	if (mode === 'regex') {
		const regex = safeRegex(target, '');
		return regex ? regex.test(value) : false;
	}
	return true;
}

function resolveTemplate(
	value: string,
	variables: Record<string, string>,
	warnings: Set<string>
): string {
	return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_whole, raw: string) => {
		const name = raw.trim();
		if (Object.hasOwn(variables, name)) return variables[name];
		warnings.add(`No value for {{${name}}} on this path — treated as empty.`);
		return '';
	});
}

function truthy(value: string): boolean {
	return value.trim().length > 0;
}

function fail(message: string, nodes: string[], edges: string[], steps: SimulationStep[]): SimulationResult {
	return {
		entered: false,
		outcome: 'error',
		summary: message,
		visitedNodes: nodes,
		visitedEdges: edges,
		variables: {},
		sms: [],
		steps,
		warnings: []
	};
}

export function simulate(
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[],
	input: SimulationInput
): SimulationResult {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const trigger = nodes.find((node) => node.type === 'trigger');
	if (!trigger) {
		return fail('This flow has no trigger, so a message cannot start it.', [], [], []);
	}

	const steps: SimulationStep[] = [];
	const visitedNodes: string[] = [];
	const visitedEdges: string[] = [];
	const sms: SimulationSms[] = [];
	const warnings = new Set<string>();
	const variables: Record<string, string> = {
		sender: input.sender,
		body: input.body,
		received_at: new Date().toISOString()
	};

	const triggerData = nodeData<TriggerData>(trigger);
	const sender = triggerData.sender ?? { mode: 'any' as const };
	const body = triggerData.body ?? { mode: 'any' as const };
	const senderOk = matchesMode(input.sender, sender.mode, sender.value);
	const bodyOk = matchesMode(input.body, body.mode, body.value);

	visitedNodes.push(trigger.id);

	if (!senderOk || !bodyOk) {
		const reason = !senderOk
			? `sender ${input.sender ? `“${input.sender}”` : '(empty)'} does not match the sender filter`
			: `body does not match the body filter`;
		steps.push({
			nodeId: trigger.id,
			tone: 'warn',
			text: `Message filtered out — ${reason}.`
		});
		return {
			entered: false,
			outcome: 'filtered',
			summary: 'This message would not start the flow.',
			visitedNodes,
			visitedEdges,
			variables,
			sms,
			steps,
			warnings: []
		};
	}

	steps.push({
		nodeId: trigger.id,
		tone: 'ok',
		text: `Message accepted: ${input.sender || '(no sender)'} · “${input.body}”.`
	});

	let current: FlowNode | undefined = trigger;
	let guard = 0;

	while (current && guard < MAX_STEPS) {
		guard += 1;
		const node = current;
		// Record every node the walk actually enters, not just the trigger: the
		// canvas highlights the path from this list, so omitting the rest left the
		// operator looking at a single green node.
		if (!visitedNodes.includes(node.id)) visitedNodes.push(node.id);
		const outgoing = edges.filter((edge) => edge.source === node.id);

		if (node.type === 'trigger') {
			const edge = outgoing[0];
			if (!edge) {
				steps.push({
					nodeId: node.id,
					tone: 'warn',
					text: 'The trigger has no outgoing connection, so nothing else runs.'
				});
				break;
			}
			visitedEdges.push(edge.id);
			current = byId.get(edge.target);
			continue;
		}

		if (node.type === 'extract') {
			const data = nodeData<ExtractData>(node);
			const subject = data.source === 'sender' ? input.sender : input.body;
			const regex = safeRegex(data.pattern ?? '', data.flags === 'i' ? 'i' : '');
			if (!regex) {
				steps.push({
					nodeId: node.id,
					tone: 'danger',
					text: 'The pattern is not a valid regular expression.'
				});
				return {
					entered: true,
					outcome: 'error',
					summary: 'The flow stopped at an invalid pattern.',
					visitedNodes,
					visitedEdges,
					variables,
					sms,
					steps,
					warnings: [...warnings]
				};
			}
			const match = regex.exec(subject);
			if (!match) {
				steps.push({
					nodeId: node.id,
					tone: 'warn',
					text: `Pattern did not match the ${data.source}. The flow stops here.`
				});
				return {
					entered: true,
					outcome: 'halted',
					summary: `Stopped at Extract — the pattern did not match the ${data.source}.`,
					visitedNodes,
					visitedEdges,
					variables,
					sms,
					steps,
					warnings: [...warnings]
				};
			}
			const captured: string[] = [];
			for (const name of extractGroupNames(data.pattern)) {
				const value = match.groups?.[name] ?? '';
				variables[name] = value;
				captured.push(`${name} = ${value === '' ? '(empty)' : value}`);
			}
			steps.push({
				nodeId: node.id,
				tone: 'ok',
				text: captured.length
					? `Captured ${captured.join(', ')}.`
					: 'Pattern matched, but declared no readable groups.'
			});
			const edge = outgoing[0];
			if (!edge) break;
			visitedEdges.push(edge.id);
			current = byId.get(edge.target);
			continue;
		}

		if (node.type === 'condition') {
			const data = nodeData<ConditionData>(node);
			const left = resolveTemplate(data.left ?? '', variables, warnings);
			const right = resolveTemplate(data.right ?? '', variables, warnings);
			let passed = false;
			let detail = '';

			switch (data.op) {
				case 'exists':
					passed = truthy(left);
					detail = `${left ? `“${left}”` : 'no value'} ${passed ? 'exists' : 'is empty'}`;
					break;
				case 'equals':
					passed = left === right;
					detail = `“${left}” ${passed ? 'equals' : 'does not equal'} “${right}”`;
					break;
				case 'not_equals':
					passed = left !== right;
					detail = `“${left}” ${passed ? 'differs from' : 'equals'} “${right}”`;
					break;
				case 'contains':
					passed = left.includes(right);
					detail = `“${left}” ${passed ? 'contains' : 'does not contain'} “${right}”`;
					break;
				case 'matches': {
					const regex = safeRegex(right, '');
					passed = regex ? regex.test(left) : false;
					detail = regex
						? `“${left}” ${passed ? 'matches' : 'does not match'} /${right}/`
						: 'the comparison pattern is invalid';
					break;
				}
			}

			steps.push({
				nodeId: node.id,
				tone: passed ? 'ok' : 'muted',
				text: `${detail} → ${passed ? 'true' : 'false'} branch.`
			});
			const edge = outgoing.find(
				(item) => item.sourceHandle === (passed ? 'true' : 'false')
			);
			if (!edge) {
				steps.push({
					nodeId: node.id,
					tone: 'warn',
					text: `The ${passed ? 'true' : 'false'} branch is not connected, so the flow stops.`
				});
				break;
			}
			visitedEdges.push(edge.id);
			current = byId.get(edge.target);
			continue;
		}

		if (node.type === 'send_sms') {
			const data = nodeData<SendSmsData>(node);
			const to = resolveTemplate(data.to ?? '', variables, warnings);
			const text = resolveTemplate(data.body ?? '', variables, warnings);
			sms.push({ nodeId: node.id, to, body: text });
			steps.push({
				nodeId: node.id,
				tone: 'ok',
				text: `Would send to ${to || '(no recipient)'}: “${text}”.`
			});
			const edge = outgoing[0];
			if (!edge) break;
			visitedEdges.push(edge.id);
			current = byId.get(edge.target);
			continue;
		}

		if (node.type === 'stop') {
			const data = nodeData<StopData>(node);
			const reason = data.reason?.trim();
			steps.push({
				nodeId: node.id,
				tone: 'muted',
				text: reason ? `Stopped: ${reason}` : 'Reached the end of the flow.'
			});
			current = undefined;
			break;
		}

		current = undefined;
	}

	if (guard >= MAX_STEPS) {
		steps.push({
			nodeId: current?.id ?? '',
			tone: 'danger',
			text: `Stopped after ${MAX_STEPS} steps to avoid a loop.`
		});
	}

	const summary =
		sms.length === 0
			? 'The flow finished without sending a message.'
			: `The flow would send ${sms.length} message${sms.length === 1 ? '' : 's'}.`;

	return {
		entered: true,
		outcome: 'delivered',
		summary,
		visitedNodes,
		visitedEdges,
		variables,
		sms,
		steps,
		warnings: [...warnings]
	};
}
