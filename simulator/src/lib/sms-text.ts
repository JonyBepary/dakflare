/**
 * How the radio will split a reply, measured the way a carrier measures it.
 *
 * GSM 03.38 counts *septets*: 160 fit in one SMS, 153 in each part of a
 * concatenated message (7 are spent on the user-data header). Anything outside
 * that alphabet — Bangla, emoji, curly quotes — forces UCS-2, which costs two
 * bytes per character: 70 in one SMS, 67 in each part. A Bangla reply is
 * therefore four times as expensive as the same length in ASCII, and the
 * composer has to say so before the operator sends it.
 *
 * The denominator the composer shows is one segment's capacity (160 or 70), and
 * the true number of parts is shown beside it; `splitCapacity` is the number
 * the parts are actually cut at.
 */

export type SmsEncoding = 'gsm7' | 'ucs2';

export type SmsMeasure = {
	encoding: SmsEncoding;
	/** Septets for GSM-7, UTF-16 code units for UCS-2. */
	units: number;
	/** One segment in this encoding: 160 or 70. */
	capacity: number;
	/** Capacity of every part once the text has to be split: 153 or 67. */
	splitCapacity: number;
	/** Real number of SMS parts, 0 for an empty body. */
	segments: number;
};

/** GSM 03.38 default alphabet, one character per septet. */
const GSM_BASIC = new Set<string>([
	'@',
	'£',
	'$',
	'¥',
	'è',
	'é',
	'ù',
	'ì',
	'ò',
	'Ç',
	'\n',
	'Ø',
	'ø',
	'\r',
	'Å',
	'å',
	'Δ',
	'_',
	'Φ',
	'Γ',
	'Λ',
	'Ω',
	'Π',
	'Ψ',
	'Σ',
	'Θ',
	'Ξ',
	'\u001b',
	'Æ',
	'æ',
	'ß',
	'É',
	' ',
	'!',
	'"',
	'#',
	'¤',
	'%',
	'&',
	"'",
	'(',
	')',
	'*',
	'+',
	',',
	'-',
	'.',
	'/',
	':',
	';',
	'<',
	'=',
	'>',
	'?',
	'¡',
	'Ä',
	'Ö',
	'Ñ',
	'Ü',
	'§',
	'¿',
	'ä',
	'ö',
	'ñ',
	'ü',
	'à'
]);

/** Characters that need an escape septet, so they cost two. */
const GSM_EXTENDED = new Set<string>(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

for (const digit of '0123456789') GSM_BASIC.add(digit);
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') GSM_BASIC.add(letter);
for (const letter of 'abcdefghijklmnopqrstuvwxyz') GSM_BASIC.add(letter);

const GSM_SINGLE = 160;
const GSM_PART = 153;
const UCS2_SINGLE = 70;
const UCS2_PART = 67;

export function measureSms(body: string): SmsMeasure {
	if (body.length === 0) {
		return {
			encoding: 'gsm7',
			units: 0,
			capacity: GSM_SINGLE,
			splitCapacity: GSM_PART,
			segments: 0
		};
	}

	let septets = 0;
	let gsm = true;
	// `for…of` walks code points, so a surrogate pair counts once here and is
	// caught by the non-GSM branch rather than counted as two characters.
	for (const character of body) {
		if (GSM_BASIC.has(character)) septets += 1;
		else if (GSM_EXTENDED.has(character)) septets += 2;
		else {
			gsm = false;
			break;
		}
	}

	if (gsm) {
		return {
			encoding: 'gsm7',
			units: septets,
			capacity: GSM_SINGLE,
			splitCapacity: GSM_PART,
			segments: septets <= GSM_SINGLE ? 1 : Math.ceil(septets / GSM_PART)
		};
	}

	// UCS-2 is counted in UTF-16 code units, which is what `length` returns:
	// an emoji is two of them on the wire, not one.
	const units = body.length;
	return {
		encoding: 'ucs2',
		units,
		capacity: UCS2_SINGLE,
		splitCapacity: UCS2_PART,
		segments: units <= UCS2_SINGLE ? 1 : Math.ceil(units / UCS2_PART)
	};
}
