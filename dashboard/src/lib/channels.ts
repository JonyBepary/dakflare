/**
 * Operator words for a messaging channel.
 *
 * `messages.channel` is free text on the wire: the Worker defaults it to `sms`
 * and a platform or plugin may use a name this console has never seen. The map
 * below is the console's own vocabulary; anything else is printed as the
 * gateway sent it, the same rule `alerts.ts` follows for an unknown kind.
 */

const WORDS: Record<string, string> = {
	sms: 'SMS',
	telegram: 'Telegram',
	whatsapp: 'WhatsApp',
	signal: 'Signal'
};

/** The channel's word, or `null` when the row does not say which channel it used. */
export function channelWord(channel: string | null | undefined): string | null {
	if (typeof channel !== 'string') return null;
	const name = channel.trim();
	if (name === '') return null;
	return WORDS[name.toLowerCase()] ?? name;
}

/**
 * Whether a session window gates a free-form reply on this channel.
 *
 * SMS has no window: the radio answers whenever the handset has service. A
 * platform (WhatsApp Cloud in particular) does, and the gateway stores that
 * state on the conversation. No route reports it yet, so the console says so
 * rather than implying a reply is allowed.
 */
export function channelHasSessionState(channel: string | null | undefined): boolean {
	const name = channelWord(channel);
	return name !== null && name.toLowerCase() !== 'sms';
}
