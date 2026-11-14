//! Why a message did not match.
//!
//! A phone that receives SMS is a hostile input device: carrier gateways insert
//! line breaks, some keyboards send a no-break space, copy-paste drags a
//! zero-width space along, and Bengali digit normalisation changes character
//! width. A pattern that is correct and still does not match is the most
//! expensive kind of bug, so this module answers the operator's question
//! directly: where did the message stop agreeing with the pattern, and what sat
//! at that offset.
//!
//! ## How the trace is built
//!
//! The walk uses the literal runs in the pattern ([`crate::prose_synth::literal_segments`])
//! and a left-to-right scan of the message. Each literal is searched for from the
//! position the previous one ended at; the byte offset after the last literal that
//! was found is `max_matched_byte`, and the first literal that was not found is
//! the `failing_token`. A class, group or quantifier between two literals is a
//! *gap*: the pattern does not spell out what lives there, so a failure after a
//! gap is reported as a slot mismatch rather than a literal one.
//!
//! The compiled `regex` is the authority on whether the message matched at all.
//! The walk only explains a failure the compiler already found; a pattern the
//! scanner cannot read (unusual syntax) simply yields `Unknown` with the match
//! verdict still correct. That combination is deliberate — the trace may be
//! less informative than the truth, never more confident than it.
//!
//! All offsets are byte offsets into the original message, and every slice is
//! taken on a `char_indices` boundary, so a UTF-8 message cannot panic the walk.

use serde::{Deserialize, Serialize};

use crate::prose_synth::{literal_segments, normalize_bangla_digits};

/// The encoding an SMS body will be sent in, and therefore its segment budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmsEncoding {
    /// 3GPP TS 23.038 default alphabet, 7 bits per septet.
    Gsm7,
    /// 16-bit UCS-2, because at least one character is outside the GSM alphabet.
    Ucs2,
}

/// The first reason the walk could name for a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    /// A zero-width character (`U+200B`, `U+FEFF`) sits where a literal was
    /// expected.
    UnicodeZeroWidth,
    /// A no-break space (`U+00A0`) sits where a plain space was expected.
    UnicodeNbsp,
    /// The literal is present only after a fullwidth/Bangla-digit width change,
    /// or the offset arithmetic would have split a multi-byte character.
    MultibyteBoundary,
    /// Nothing in the message agreed with the pattern's first literal.
    PrefixMismatch,
    /// The fixed text matched up to a value gap, and what followed did not.
    SlotMismatch,
    /// The literal is present once whitespace is collapsed: the message was
    /// wrapped at a segment boundary and the pattern demanded one space.
    SegmentBoundary,
    /// The walk could not name a cause.
    Unknown,
}

/// One invisible character in the message, with the byte offset it occupies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Invisible {
    pub byte: usize,
    pub ch: char,
    pub label: &'static str,
}

/// The outcome of tracing a pattern against a message.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MatchFailure {
    /// The compiled pattern matched the whole message.
    pub matched: bool,
    /// Byte offset after the last literal the walk found.
    pub max_matched_byte: usize,
    /// `max_matched_byte` as a character offset.
    pub max_matched_char: usize,
    /// The first literal the walk could not find.
    pub failing_token: Option<String>,
    /// Why it could not be found, when the walk can say.
    pub code: Option<DiagnosticCode>,
    /// Every invisible character in the message, in order.
    pub invisible: Vec<Invisible>,
    /// Encoding the body will use.
    pub encoding: SmsEncoding,
    /// Segments the body occupies.
    pub segments: usize,
    /// Characters (or septets) that fit in the first segment.
    pub chars_in_first_segment: usize,
}

/* ---------------------------------------------------------------- encoding */

/// GSM 7-bit default alphabet, 3GPP TS 23.038 §6.2.1.
const GSM7_BASIC: &str = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/// GSM 7-bit extension table, 3GPP TS 23.038 §6.2.1.1. Each character is an
/// escape plus one septet, so it costs two of the 160.
const GSM7_EXTENSION: &str = "\u{0C}^{}\\[~]|€";

/// Septets one character costs, or `None` when it is outside the GSM alphabet.
fn gsm7_septets(ch: char) -> Option<usize> {
    if GSM7_BASIC.contains(ch) {
        Some(1)
    } else if GSM7_EXTENSION.contains(ch) {
        Some(2)
    } else {
        None
    }
}

/// GSM-7 only when every character is in the 3GPP TS 23.038 alphabet.
///
/// One character outside it forces UCS-2 for the whole message, which is why
/// this is a property of the body and not of a character.
pub fn sms_encoding(message: &str) -> SmsEncoding {
    if message.chars().all(|ch| gsm7_septets(ch).is_some()) {
        SmsEncoding::Gsm7
    } else {
        SmsEncoding::Ucs2
    }
}

/// Characters that fit in the first segment, per encoding.
pub fn chars_in_first_segment(encoding: SmsEncoding) -> usize {
    match encoding {
        SmsEncoding::Gsm7 => 160,
        SmsEncoding::Ucs2 => 70,
    }
}

/// Segments the body occupies: 160/153 for GSM-7 (extension characters cost two
/// septets), 70/67 for UCS-2.
///
/// UCS-2 is counted in characters rather than UTF-16 code units; a body with
/// astral characters is under-counted by that convention, which is stated here
/// so a caller that bills per segment knows the difference. Every character in
/// this crate's corpus (Latin, Bangla, punctuation) is a single UTF-16 unit.
pub fn segment_count(message: &str) -> usize {
    match sms_encoding(message) {
        SmsEncoding::Gsm7 => {
            let septets: usize = message
                .chars()
                .map(|ch| gsm7_septets(ch).unwrap_or(1))
                .sum();
            if septets <= 160 {
                1
            } else {
                septets.div_ceil(153)
            }
        }
        SmsEncoding::Ucs2 => {
            let chars = message.chars().count();
            if chars <= 70 { 1 } else { chars.div_ceil(67) }
        }
    }
}

/* --------------------------------------------------------------- invisible */

const ZERO_WIDTH_SPACE: char = '\u{200B}';
const ZERO_WIDTH_NO_BREAK_SPACE: char = '\u{FEFF}';
const NO_BREAK_SPACE: char = '\u{00A0}';

/// Every character a reader cannot see but a pattern can trip over.
fn invisible_chars(message: &str) -> Vec<Invisible> {
    message
        .char_indices()
        .filter_map(|(byte, ch)| {
            let label = match ch {
                ZERO_WIDTH_SPACE => "zero-width space",
                ZERO_WIDTH_NO_BREAK_SPACE => "zero-width no-break space (BOM)",
                NO_BREAK_SPACE => "no-break space",
                _ => return None,
            };
            Some(Invisible { byte, ch, label })
        })
        .collect()
}

/* ------------------------------------------------------------------- trace */

/// Collapse every whitespace run to one space, so a message wrapped at a segment
/// boundary can be compared with a pattern that spells one space.
fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut on_space = false;
    for ch in value.chars() {
        if ch.is_whitespace() {
            if !on_space {
                out.push(' ');
                on_space = true;
            }
        } else {
            out.push(ch);
            on_space = false;
        }
    }
    out
}

/// A literal the walk stopped on, and what it took to get there.
struct FailurePoint {
    token: String,
    at: usize,
    after_gap: bool,
    /// True when the literal was searched for and not found, as opposed to a gap
    /// inferred because every literal matched but the pattern still refused.
    raw_miss: bool,
}

/// Trace `pattern` against `message` and say why it did not match.
///
/// The verdict (`matched`) comes from the compiled pattern. The offsets and the
/// code describe the first literal the walk could not find, or — when every
/// literal was found but the pattern still refused the message — whatever sits
/// at the end of the matched prefix.
pub fn trace_match_failure(pattern: &str, message: &str) -> MatchFailure {
    let encoding = sms_encoding(message);
    let invisible = invisible_chars(message);
    let segments = literal_segments(pattern);
    let compiled = regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build();
    let matched = compiled
        .as_ref()
        .map(|regex| regex.is_match(message))
        .unwrap_or(false);

    let mut reached = 0usize;
    let mut failure: Option<FailurePoint> = None;
    // The first literal that sits after a gap: when every literal is found and
    // the pattern still refuses the message, the gap is where the wrong text is.
    let mut first_gap: Option<(String, usize)> = None;

    if !matched {
        for segment in &segments {
            // `reached` is always a character boundary: it is the end of a match
            // the compiler found, and matches start and end on boundaries.
            match message[reached..].find(&segment.text) {
                Some(found) => {
                    let start = reached + found;
                    if segment.after_gap && first_gap.is_none() {
                        first_gap = Some((segment.text.clone(), start));
                    }
                    reached = start + segment.text.len();
                }
                None => {
                    failure = Some(FailurePoint {
                        token: segment.text.clone(),
                        at: reached,
                        after_gap: segment.after_gap,
                        raw_miss: true,
                    });
                    break;
                }
            }
        }

        if failure.is_none()
            && let Some((token, at)) = first_gap
        {
            reached = at;
            failure = Some(FailurePoint {
                token,
                at,
                after_gap: true,
                raw_miss: false,
            });
        }
    }

    let max_matched_byte = if matched { message.len() } else { reached };
    let max_matched_char = message[..max_matched_byte].chars().count();

    let code = if matched {
        None
    } else if compiled.is_err() {
        // The pattern itself is broken; the walk cannot explain a message
        // against an expression that was never valid.
        Some(DiagnosticCode::Unknown)
    } else {
        Some(classify(
            &invisible,
            failure.as_ref(),
            max_matched_byte,
            message,
            &segments,
        ))
    };

    MatchFailure {
        matched,
        max_matched_byte,
        max_matched_char,
        failing_token: if matched {
            None
        } else {
            failure.map(|point| point.token)
        },
        code,
        invisible,
        encoding,
        segments: segment_count(message),
        chars_in_first_segment: chars_in_first_segment(encoding),
    }
}

fn classify(
    invisible: &[Invisible],
    failure: Option<&FailurePoint>,
    max_matched_byte: usize,
    message: &str,
    segments: &[crate::prose_synth::LiteralSegment],
) -> DiagnosticCode {
    // A character nobody can see is the most common silent cause, and it is
    // always worth naming before anything structural: the operator fixes it by
    // normalising the sender's text, not by touching the pattern.
    if let Some(found) = invisible.iter().find(|item| item.byte >= max_matched_byte) {
        return match found.ch {
            ZERO_WIDTH_SPACE | ZERO_WIDTH_NO_BREAK_SPACE => DiagnosticCode::UnicodeZeroWidth,
            NO_BREAK_SPACE => DiagnosticCode::UnicodeNbsp,
            _ => DiagnosticCode::Unknown,
        };
    }

    let Some(point) = failure else {
        // Every literal was found, yet the pattern refused the message: an
        // anchor, a quantifier over a gap, or syntax the scanner does not model.
        return DiagnosticCode::Unknown;
    };

    let tail = &message[point.at..];

    if point.raw_miss {
        // The literal is there, but the message was wrapped: one space in the
        // pattern against a newline in the body.
        if collapse_whitespace(tail).contains(&collapse_whitespace(&point.token)) {
            return DiagnosticCode::SegmentBoundary;
        }

        // A width change (fullwidth forms, Bangla digits) makes the same words a
        // different byte string. `normalize_bangla_digits` is exactly that
        // mapping, so a hit after normalisation is a boundary, not a bad pattern.
        if normalize_bangla_digits(tail).contains(&point.token) {
            return DiagnosticCode::MultibyteBoundary;
        }
    }

    if point.at == 0
        && segments
            .first()
            .map(|segment| segment.text == point.token)
            .unwrap_or(false)
    {
        return DiagnosticCode::PrefixMismatch;
    }

    if point.after_gap {
        return DiagnosticCode::SlotMismatch;
    }

    DiagnosticCode::Unknown
}

/* ------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;

    fn code(pattern: &str, message: &str) -> Option<DiagnosticCode> {
        trace_match_failure(pattern, message).code
    }

    #[test]
    fn a_matching_message_reports_no_error_at_the_end() {
        let trace = trace_match_failure(
            r"Ref[\s:=]*(?<ref>[A-Za-z0-9 _-]{1,40})",
            "Payment sent. Ref CUS512.",
        );
        assert!(trace.matched);
        assert_eq!(trace.code, None);
        assert_eq!(trace.failing_token, None);
        assert_eq!(trace.max_matched_byte, "Payment sent. Ref CUS512.".len());
        assert_eq!(trace.max_matched_char, 25);
    }

    #[test]
    fn a_zero_width_space_is_named_with_its_byte_offset() {
        let trace = trace_match_failure(
            r"Ref[\s:=]*(?<ref>[A-Za-z0-9_-]+)",
            "Payment. Ref\u{200B}CUS512.",
        );
        assert!(!trace.matched);
        assert_eq!(trace.code, Some(DiagnosticCode::UnicodeZeroWidth));
        assert_eq!(
            trace.invisible,
            vec![Invisible {
                byte: 12,
                ch: '\u{200B}',
                label: "zero-width space",
            }]
        );
        // The walk got as far as the label before the invisible character.
        assert_eq!(trace.max_matched_byte, 12);
    }

    #[test]
    fn a_no_break_space_is_named_with_its_byte_offset() {
        // A literal space in the pattern does not accept `U+00A0`, which is
        // exactly the trap this code exists to name.
        let trace =
            trace_match_failure(r"Ref (?<ref>[A-Za-z0-9_-]+)", "Payment. Ref\u{00A0}CUS512.");
        assert_eq!(trace.code, Some(DiagnosticCode::UnicodeNbsp));
        assert_eq!(trace.invisible.len(), 1);
        assert_eq!(trace.invisible[0].byte, 12);
        assert_eq!(trace.invisible[0].label, "no-break space");
    }

    #[test]
    fn a_wrong_opening_is_a_prefix_mismatch() {
        let trace = trace_match_failure(
            r"Payment[\s:=]*(?<amount>[0-9]+)",
            "You have received Tk 800.00",
        );
        assert!(!trace.matched);
        assert_eq!(trace.code, Some(DiagnosticCode::PrefixMismatch));
        assert_eq!(trace.failing_token.as_deref(), Some("Payment"));
        assert_eq!(trace.max_matched_byte, 0);
    }

    #[test]
    fn a_value_of_the_wrong_shape_is_a_slot_mismatch() {
        let trace = trace_match_failure(r"Payment[\s:=]*(?<amount>[0-9]+)\s+to", "Payment abc to");
        assert!(!trace.matched);
        assert_eq!(trace.code, Some(DiagnosticCode::SlotMismatch));
        assert_eq!(trace.failing_token.as_deref(), Some("to"));
    }

    #[test]
    fn a_literal_wrapped_at_a_segment_boundary_is_named() {
        // The pattern says one space; the carrier inserted a newline.
        let trace = trace_match_failure(r"Tk 800\.00 from", "Tk 800.00\nfrom Dhaka");
        assert!(!trace.matched);
        assert_eq!(trace.code, Some(DiagnosticCode::SegmentBoundary));
    }

    #[test]
    fn a_fullwidth_body_is_a_multibyte_boundary() {
        let trace = trace_match_failure(r"Code[\s:=]*(?<code>[0-9]+)", "Ｃｏｄｅ 483920");
        assert!(!trace.matched);
        assert_eq!(trace.code, Some(DiagnosticCode::MultibyteBoundary));
    }

    #[test]
    fn an_invalid_pattern_is_unknown_not_a_panic() {
        let trace = trace_match_failure("(unclosed", "anything at all");
        assert!(!trace.matched);
        assert_eq!(trace.code, Some(DiagnosticCode::Unknown));
    }

    #[test]
    fn gsm7_and_ucs2_are_detected_per_the_default_alphabet() {
        assert_eq!(sms_encoding("Ref CUS512 @ £$¥"), SmsEncoding::Gsm7);
        assert_eq!(sms_encoding("Ref ৳৮০০"), SmsEncoding::Ucs2);
        // The euro sign is in the extension table, so it is still GSM-7.
        assert_eq!(sms_encoding("Fee 2€"), SmsEncoding::Gsm7);
        assert_eq!(chars_in_first_segment(SmsEncoding::Gsm7), 160);
        assert_eq!(chars_in_first_segment(SmsEncoding::Ucs2), 70);
    }

    #[test]
    fn segment_counts_follow_the_160_153_and_70_67_budgets() {
        assert_eq!(segment_count(&"a".repeat(160)), 1);
        assert_eq!(segment_count(&"a".repeat(161)), 2);
        assert_eq!(segment_count(&"a".repeat(306)), 2);
        assert_eq!(segment_count(&"a".repeat(307)), 3);

        assert_eq!(segment_count(&"৳".repeat(70)), 1);
        assert_eq!(segment_count(&"৳".repeat(71)), 2);
        assert_eq!(segment_count(&"৳".repeat(134)), 2);
        assert_eq!(segment_count(&"৳".repeat(135)), 3);

        // An extension character costs two septets.
        assert_eq!(segment_count(&"€".repeat(80)), 1);
        assert_eq!(segment_count(&"€".repeat(81)), 2);
    }

    #[test]
    fn offsets_are_character_safe_on_a_multibyte_message() {
        let trace = trace_match_failure(r"৳[\s:=]*(?<amount>[0-9]+)", "আপনার টাকা ৮০০ পেয়েছেন");
        assert!(!trace.matched);
        // Every reported offset must be usable as a string boundary.
        let message = "আপনার টাকা ৮০০ পেয়েছেন";
        assert!(message.is_char_boundary(trace.max_matched_byte));
        assert_eq!(
            trace.max_matched_char,
            message[..trace.max_matched_byte].chars().count()
        );
        assert_eq!(trace.encoding, SmsEncoding::Ucs2);
    }

    #[test]
    fn a_brace_quantifier_and_a_named_group_are_one_literal_run() {
        // The scanner must not read `(?<ref>` or `{1,40}` as literal text.
        let trace = trace_match_failure(
            r"(?:Ref (?<ref>[A-Za-z]{1,40}))",
            "Payment sent. Reference CUS512.",
        );
        assert!(!trace.matched);
        assert_eq!(trace.failing_token.as_deref(), Some("Ref "));
        // The whole run is `Ref ` and the message says `Reference `, so nothing
        // of it matched; the offset is the start of the message.
        assert_eq!(trace.max_matched_byte, 0);
        assert_eq!(trace.code, Some(DiagnosticCode::PrefixMismatch));
        assert_eq!(code(r"(?:Ref (?<ref>[A-Za-z]{1,40}))", "Ref CUS512."), None);
    }
}
