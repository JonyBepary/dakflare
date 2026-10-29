/**
 * Who answered an inbound message, in operator words (design review `05` §2.1).
 *
 * The wire carries two different facts and they are not the same axis:
 * `reply_source` is set by the gateway when a rule answered, while `auto_reply`
 * is set by the phone when it answered on its own (a flow). An inbound row with
 * neither was not answered, and saying nothing would leave the operator to guess.
 *
 * Outbound rows are the answer, so they carry no phrase at all.
 */

import type { Message } from './types';

export type AnswerSource = 'rule' | 'flow' | 'none';

type AnswerFields = Pick<
	Message,
	'direction' | 'reply_source' | 'reply_ref' | 'auto_reply'
>;

/** `null` for an outbound row: the question does not apply to it. */
export function answerOf(message: AnswerFields): AnswerSource | null {
	if (message.direction !== 'in') return null;
	if (message.reply_source === 'rule') return 'rule';
	// The Worker only writes `rule` today; any other recorded source is the
	// phone answering on its own, and `auto_reply` is the older signal for it.
	if (message.reply_source) return 'flow';
	if (message.auto_reply) return 'flow';
	return 'none';
}

/**
 * One short phrase for the row. `ruleName` is the resolved rule name; when the
 * rule has since been deleted the caller passes nothing and the id is not shown
 * in the sentence — the row's own body is more useful than a dangling id.
 */
export function answerPhrase(message: AnswerFields, ruleName?: string | null): string | null {
	switch (answerOf(message)) {
		case 'rule':
			return ruleName ? `Answered by rule ${ruleName}` : 'Answered by a rule';
		case 'flow':
			return 'Answered on the phone';
		case 'none':
			return 'Not answered';
		default:
			return null;
	}
}
