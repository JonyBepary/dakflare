/**
 * Operator words and metadata for a messaging channel.
 *
 * `messages.channel` is free text on the wire: the Worker defaults it to `sms`
 * and a platform or plugin may use a name this console has never seen. The map
 * below is the console's own vocabulary; anything else is printed as the
 * gateway sent it, the same rule `alerts.ts` follows for an unknown kind.
 *
 * `OFFICIAL_CHANNELS` is a narrower list than the map: it names the accounts a
 * connector can be created for from this console. The `personal_*` words cover
 * a phone-relayed app channel, which no connector row describes.
 */

import type { InstagramAuthMode, OfficialChannelId } from './types';

export type { OfficialChannelId };

const WORDS: Record<string, string> = {
	sms: 'SMS',
	telegram: 'Telegram',
	whatsapp: 'WhatsApp',
	messenger: 'Messenger',
	instagram: 'Instagram',
	signal: 'Signal',
	// The phone relays these from its own notification feed; the word says so
	// rather than reading as the official cloud API of the same app. The names
	// are the ones `/v1/edge/incoming/batch` actually stores, channel first.
	whatsapp_personal: 'Personal WhatsApp',
	telegram_personal: 'Personal Telegram',
	messenger_personal: 'Personal Messenger',
	instagram_personal: 'Personal Instagram'
};

export interface OfficialChannelMeta {
	id: OfficialChannelId;
	/** The platform's name, not the connector's label: "WhatsApp", not "Support". */
	word: string;
	/** The API family this connector belongs to, for the form's heading. */
	label: string;
	accountIdLabel: string;
	accountIdPlaceholder: string;
	/** WhatsApp sends outside its window with an approved template. */
	supportsTemplates: boolean;
	/** Messenger may use the 7-day HUMAN_AGENT tag. */
	supportsHumanAgentTag: boolean;
	/** Instagram may answer a comment with a 7-day private reply. */
	supportsCommentReply: boolean;
	/** Instagram stores which login produced its token. */
	supportsAuthModes: boolean;
}

/**
 * The four platforms a connector can be created for, in the order the form
 * offers them: the two Meta messaging surfaces first, then Telegram.
 */
export const OFFICIAL_CHANNELS: readonly OfficialChannelMeta[] = [
	{
		id: 'whatsapp',
		word: 'WhatsApp',
		label: 'WhatsApp Cloud API',
		accountIdLabel: 'Phone Number ID',
		accountIdPlaceholder: 'e.g. 104829104829104',
		supportsTemplates: true,
		supportsHumanAgentTag: false,
		supportsCommentReply: false,
		supportsAuthModes: false
	},
	{
		id: 'telegram',
		word: 'Telegram',
		label: 'Telegram Bot API',
		accountIdLabel: 'Bot id or username',
		accountIdPlaceholder: 'e.g. 7123456789',
		supportsTemplates: false,
		supportsHumanAgentTag: false,
		supportsCommentReply: false,
		supportsAuthModes: false
	},
	{
		id: 'messenger',
		word: 'Messenger',
		label: 'Facebook Messenger',
		accountIdLabel: 'Facebook Page ID',
		accountIdPlaceholder: 'e.g. 109283746501928',
		supportsTemplates: false,
		supportsHumanAgentTag: true,
		supportsCommentReply: false,
		supportsAuthModes: false
	},
	{
		id: 'instagram',
		word: 'Instagram',
		label: 'Instagram Messaging',
		accountIdLabel: 'Instagram account ID (IGSID)',
		accountIdPlaceholder: 'e.g. 17841400123456789',
		supportsTemplates: false,
		supportsHumanAgentTag: false,
		supportsCommentReply: true,
		supportsAuthModes: true
	}
] as const;

/** The Instagram login choices, in the order Meta recommends them. */
export const INSTAGRAM_AUTH_MODES: readonly { value: InstagramAuthMode; label: string }[] = [
	{ value: 'unified_login', label: 'Unified Login (recommended)' },
	{ value: 'instagram_login', label: 'Instagram Login' },
	{ value: 'facebook_login', label: 'Facebook Login' }
] as const;

/** The channel's word, or `null` when the row does not say which channel it used. */
export function channelWord(channel: string | null | undefined): string | null {
	if (typeof channel !== 'string') return null;
	const name = channel.trim();
	if (name === '') return null;
	return WORDS[name.toLowerCase()] ?? name;
}

/** The metadata for a connector row's channel, or `null` for a channel this form cannot create. */
export function channelMeta(channel: string | null | undefined): OfficialChannelMeta | null {
	if (typeof channel !== 'string') return null;
	return OFFICIAL_CHANNELS.find((meta) => meta.id === channel) ?? null;
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

/**
 * What a connector send's refusal means, in the operator's terms.
 *
 * `/v1/channels/.../send` answers a failure with an HTTP error status and the
 * delivery result's `errorCode` in the body, so the client would otherwise show
 * "Request failed (400)". These are the codes the Worker actually returns, each
 * with the next action rather than the wire name. `null` means this map has
 * nothing to add and the caller should show the gateway's own sentence.
 */
const SEND_FAILURES: Record<string, string> = {
	connector_not_found: 'That connector no longer exists. Reload the page.',
	connector_disabled: 'That connector is paused. Turn it back on under Channels.',
	connector_secret_unavailable:
		'This connector has no credential the gateway can open. Enter its tokens again under Channels.',
	opted_out: 'This person opted out, so nothing more can be sent to them.',
	unsupported_channel: 'This channel cannot send from the console.',
	telegram_bot_token_missing:
		'The Telegram connector has no bot token. Enter it again under Channels.',
	whatsapp_credentials_missing:
		'The WhatsApp connector has no access token. Enter it again under Channels.',
	messenger_credentials_missing:
		'The Messenger connector has no page access token. Enter it again under Channels.',
	instagram_credentials_missing:
		'The Instagram connector has no access token. Enter it again under Channels.',
	template_required:
		'WhatsApp needs an approved template outside its 24 hour window. Name the template and send again.',
	rate_limited: 'The platform is rate limiting this account. Wait a moment and try again.',
	network_error: 'The platform did not answer. Check the connector and try again.',
	permission: 'Only an owner or admin can send through a connector.'
};

export function channelSendFailure(
	code: string | null | undefined,
	substate?: string | null
): string | null {
	if (typeof code !== 'string' || code === '') return null;
	if (code === 'window_expired') {
		if (typeof substate === 'string' && substate.includes('whatsapp')) {
			return 'The 24 hour window is closed. WhatsApp allows a free-form reply only inside it; send an approved template instead.';
		}
		return 'The 24 hour window is closed. Use the Messenger human agent tag, or reply to an Instagram comment, to reach this person.';
	}
	const known = SEND_FAILURES[code];
	if (known) return known;
	// Platform errors carry a numeric code in the name, such as whatsapp_error_131047.
	const platform = /^(whatsapp|messenger|instagram|telegram)_error_(\d+)$/.exec(code);
	if (platform) {
		return `The ${channelWord(platform[1]) ?? platform[1]} API refused this message (code ${platform[2]}).`;
	}
	return null;
}
