/**
 * 3GPP TS 23.038 / GSM 03.38 Segment and Encoding Calculator.
 *
 * Accurately calculates GSM-7 vs. UCS-2 segments, detects non-GSM-7 downgrade
 * traps (such as ৳ or smart quotes), and calculates live BDT carrier costs.
 */

// GSM-7 7-bit basic character set (128 characters)
const GSM7_BASIC = new Set([
	'@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
	'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', '\x1B', 'Æ', 'æ', 'ß', 'É',
	' ', '!', '"', '#', '¤', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/',
	'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
	'¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
	'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
	'¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
	'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à'
]);

// GSM-7 extension character set (each takes 2 septets with 0x1B escape)
const GSM7_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export interface NonGsmChar {
	char: string;
	index: number;
	suggestedReplacement?: string;
}

export interface SmsEncodingMetrics {
	encoding: 'GSM-7' | 'UCS-2';
	unitsUsed: number;
	unitsLimit: number;
	segments: number;
	unitsRemainingInSegment: number;
	hasBangla: boolean;
	nonGsmChars: NonGsmChar[];
	estimatedCostBdt: number;
}

const COMMON_REPLACEMENTS: Record<string, string> = {
	'৳': 'Tk ',
	'’': "'",
	'‘': "'",
	'“': '"',
	'”': '"',
	'–': '-',
	'—': '-',
	'…': '...',
	'•': '*'
};

/**
 * Measure SMS text segments according to 3GPP TS 23.038 standards.
 */
export function measureSmsSegments(text: string): SmsEncodingMetrics {
	if (!text) {
		return {
			encoding: 'GSM-7',
			unitsUsed: 0,
			unitsLimit: 160,
			segments: 1,
			unitsRemainingInSegment: 160,
			hasBangla: false,
			nonGsmChars: [],
			estimatedCostBdt: 0.25
		};
	}

	let isGsm7 = true;
	let gsmSeptets = 0;
	const nonGsmChars: NonGsmChar[] = [];
	let hasBangla = false;

	// Check characters
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const code = ch.charCodeAt(0);

		// Check Bangla Unicode block (U+0980 - U+09FF)
		if (code >= 0x0980 && code <= 0x09ff) {
			hasBangla = true;
		}

		if (GSM7_BASIC.has(ch)) {
			gsmSeptets += 1;
		} else if (GSM7_EXTENDED.has(ch)) {
			gsmSeptets += 2;
		} else {
			isGsm7 = false;
			nonGsmChars.push({
				char: ch,
				index: i,
				suggestedReplacement: COMMON_REPLACEMENTS[ch]
			});
		}
	}

	if (isGsm7) {
		const unitsUsed = gsmSeptets;
		let segments = 1;
		let unitsLimit = 160;

		if (unitsUsed > 160) {
			segments = Math.ceil(unitsUsed / 153);
			unitsLimit = segments * 153;
		}

		const unitsRemainingInSegment = unitsUsed <= 160 ? 160 - unitsUsed : unitsLimit - unitsUsed;
		const estimatedCostBdt = segments * 0.25;

		return {
			encoding: 'GSM-7',
			unitsUsed,
			unitsLimit,
			segments,
			unitsRemainingInSegment: Math.max(0, unitsRemainingInSegment),
			hasBangla: false,
			nonGsmChars: [],
			estimatedCostBdt
		};
	}

	// UCS-2 encoding
	const ucs2Units = text.length;
	let segments = 1;
	let unitsLimit = 70;

	if (ucs2Units > 70) {
		segments = Math.ceil(ucs2Units / 67);
		unitsLimit = segments * 67;
	}

	const unitsRemainingInSegment = ucs2Units <= 70 ? 70 - ucs2Units : unitsLimit - ucs2Units;
	const estimatedCostBdt = segments * 0.50;

	return {
		encoding: 'UCS-2',
		unitsUsed: ucs2Units,
		unitsLimit,
		segments,
		unitsRemainingInSegment: Math.max(0, unitsRemainingInSegment),
		hasBangla,
		nonGsmChars,
		estimatedCostBdt
	};
}

/**
 * Replace non-GSM characters with safe GSM-7 equivalents (e.g. ৳ -> Tk ).
 */
export function sanitizeGsm7Text(text: string): string {
	let result = text;
	for (const [nonGsm, replacement] of Object.entries(COMMON_REPLACEMENTS)) {
		result = result.replaceAll(nonGsm, replacement);
	}
	return result;
}
