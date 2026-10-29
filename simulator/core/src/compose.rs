//! The compose policy: what may be handed to the radio.
//!
//! This module is the authority for the Rust command surface. Its wording is
//! copied from `simulator/src/lib/recipient.ts` and `sms-text.ts` verbatim, so
//! a refusal cannot say one thing in the field and another from the backend.
//!
//! Coverage: recipients (mask, shortcode, characters, digit count) and bodies
//! (empty, over the cap), with the webview's exact sentences.
//!
//! Where the rules also live:
//!
//! - `recipient.ts` / `sms-text.ts` mirror these sentences because the field
//!   must answer before a round trip; core is the copy the backend enforces.
//! - `SmsSender.kt` (the Android bridge, a separate lane) still has its own
//!   mask/shortcode test and a **10-digit** floor with its own wording. It is
//!   stricter than these rules, so it cannot let through a number core allows,
//!   but the two are not yet provably identical: 7–9 digit numbers dial from
//!   core and the field, and Kotlin refuses them. Making it call this module
//!   through `NativeBridge` is the bridge lane's change, not this one.
//!
//! `MAX_COMPOSE_BODY_CHARS` is counted in UTF-16 code units because that is
//! what `body.length` is on both the webview and Kotlin, so the cap agrees with
//! the surfaces even where the recipient floor does not.
//!
//! Two details are ordered the way the UI orders them:
//!
//! 1. Letters first: a mask is a considered sender id, not a typo in a number.
//! 2. A shortcode is a bare 3–6 digit run, checked before the format rule, so
//!    "12 345" gets the shortcode sentence rather than the character one.
//!
//! Nothing here carries a recipient or a body into a message: only counts.

/// One typed message, not a carrier payload.
pub const MAX_COMPOSE_BODY_CHARS: usize = 1600;

/// E.164 tops out at 15 digits; below 7 is not a number a phone can dial.
pub const MIN_RECIPIENT_DIGITS: usize = 7;
pub const MAX_RECIPIENT_DIGITS: usize = 15;

/// Why a recipient or body cannot be sent. The variants carry counts only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposeProblem {
    EmptyRecipient,
    /// Alphanumeric sender id: it cannot receive replies.
    Mask,
    /// A bare 3–6 digit run: it cannot receive replies either.
    Shortcode,
    Characters,
    Short(u32),
    Long(u32),
    EmptyBody,
    BodyTooLong(u32),
}

const MASK_SENTENCE: &str =
    "This sender is a mask, a sender that cannot receive replies; messages are not sent to it";
const SHORTCODE_SENTENCE: &str =
    "This sender is a shortcode, a sender that cannot receive replies; messages are not sent to it";

impl ComposeProblem {
    /// The whole sentence, in the UI's words, with the count appended where the
    /// screen would put it in mono.
    pub fn sentence(self) -> String {
        match self {
            Self::EmptyRecipient => "Enter the number to send to".to_string(),
            Self::Mask => MASK_SENTENCE.to_string(),
            Self::Shortcode => SHORTCODE_SENTENCE.to_string(),
            Self::Characters => "Use digits only, with an optional leading +".to_string(),
            Self::Short(digits) => format!(
                "A phone number needs at least {MIN_RECIPIENT_DIGITS} digits; this one has {digits}"
            ),
            Self::Long(digits) => format!(
                "A phone number has at most {MAX_RECIPIENT_DIGITS} digits; this one has {digits}"
            ),
            Self::EmptyBody => "The message is empty".to_string(),
            Self::BodyTooLong(chars) => format!(
                "A message holds at most {MAX_COMPOSE_BODY_CHARS} characters; this one has {chars}"
            ),
        }
    }
}

/// The cap's unit: UTF-16 code units, which is what `body.length` is on both
/// the webview and Kotlin. An emoji is therefore two, as it is on the wire.
pub fn body_chars(body: &str) -> usize {
    body.encode_utf16().count()
}

/// Any Unicode letter makes this a mask. Same property as `\p{L}` in the field
/// for every practical sender id; `is_alphabetic` is deliberately broad so a
/// script we have not thought of is refused rather than dialled.
fn has_letter(value: &str) -> bool {
    value.chars().any(char::is_alphabetic)
}

/// A shortcode is a bare digit run of 3–6, with no leading `+`. Separators are
/// ignored for this test exactly as `reply-target.ts` ignores them.
fn is_shortcode(value: &str) -> bool {
    if value.starts_with('+') {
        return false;
    }
    let digits: String = value
        .chars()
        .filter(|character| {
            !character.is_whitespace() && !matches!(character, '(' | ')' | '.' | '-')
        })
        .collect();
    (3..=6).contains(&digits.len()) && digits.chars().all(|character| character.is_ascii_digit())
}

/// Check a recipient and return it trimmed, exactly as the radio should dial it.
pub fn check_recipient(raw: &str) -> Result<&str, ComposeProblem> {
    let to = raw.trim();

    if to.is_empty() {
        return Err(ComposeProblem::EmptyRecipient);
    }
    if has_letter(to) {
        return Err(ComposeProblem::Mask);
    }
    if is_shortcode(to) {
        return Err(ComposeProblem::Shortcode);
    }

    // A leading `+` and digits, nothing else. Spaces, dashes and brackets are
    // refused rather than quietly removed: the number dialled must be the one
    // on screen.
    let digits = match to.strip_prefix('+') {
        Some(rest) => rest,
        None => to,
    };
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return Err(ComposeProblem::Characters);
    }

    let count = digits.len() as u32;
    if (count as usize) < MIN_RECIPIENT_DIGITS {
        return Err(ComposeProblem::Short(count));
    }
    if (count as usize) > MAX_RECIPIENT_DIGITS {
        return Err(ComposeProblem::Long(count));
    }

    Ok(to)
}

/// Check a body. Empty means empty after trim, not a single space.
pub fn check_body(body: &str) -> Result<(), ComposeProblem> {
    if body.trim().is_empty() {
        return Err(ComposeProblem::EmptyBody);
    }
    let chars = body_chars(body);
    if chars > MAX_COMPOSE_BODY_CHARS {
        return Err(ComposeProblem::BodyTooLong(chars as u32));
    }
    Ok(())
}

/// The one entry the command surface calls: recipient first, then body, with
/// the recipient returned trimmed for the plugin request.
pub fn check_send<'a>(to: &'a str, body: &str) -> Result<&'a str, ComposeProblem> {
    let to = check_recipient(to)?;
    check_body(body)?;
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(raw: &str) -> ComposeProblem {
        check_recipient(raw).unwrap_err()
    }

    #[test]
    fn mask_is_refused_with_the_fields_sentence() {
        assert_eq!(refusal("bKash"), ComposeProblem::Mask);
        assert_eq!(
            ComposeProblem::Mask.sentence(),
            "This sender is a mask, a sender that cannot receive replies; messages are not sent to it"
        );
        // Any script counts, not only Latin.
        assert_eq!(refusal("বিকাশ"), ComposeProblem::Mask);
    }

    #[test]
    fn shortcode_is_refused_with_its_own_sentence() {
        assert_eq!(refusal("12345"), ComposeProblem::Shortcode);
        assert_eq!(
            ComposeProblem::Shortcode.sentence(),
            "This sender is a shortcode, a sender that cannot receive replies; messages are not sent to it"
        );
        // The field strips separators before deciding this, and so does core.
        assert_eq!(refusal("12 345"), ComposeProblem::Shortcode);
        assert_eq!(refusal("12-345"), ComposeProblem::Shortcode);
    }

    #[test]
    fn six_digits_are_a_shortcode_and_seven_dial() {
        // 3–6 digits is the field's shortcode branch, so it gets that sentence.
        assert_eq!(refusal("123456"), ComposeProblem::Shortcode);
        assert_eq!(check_recipient("1234567"), Ok("1234567"));
        assert_eq!(check_recipient("+1234567"), Ok("+1234567"));
    }

    #[test]
    fn one_or_two_digits_are_short_and_sixteen_long() {
        assert_eq!(refusal("12"), ComposeProblem::Short(2));
        assert_eq!(
            ComposeProblem::Short(2).sentence(),
            "A phone number needs at least 7 digits; this one has 2"
        );
        assert_eq!(refusal("1234567890123456"), ComposeProblem::Long(16));
        assert_eq!(
            ComposeProblem::Long(16).sentence(),
            "A phone number has at most 15 digits; this one has 16"
        );
    }

    #[test]
    fn fifteen_digits_still_dial() {
        assert_eq!(
            check_recipient("+123456789012345"),
            Ok("+123456789012345")
        );
    }

    #[test]
    fn separators_and_a_misplaced_plus_are_refused() {
        let expected = ComposeProblem::Characters;
        for raw in [
            "+880 1540 196080",
            "++8801540196080",
            "+8801540196080*",
            "880+1540196080",
        ] {
            assert_eq!(refusal(raw), expected, "{raw}");
        }
        assert_eq!(
            ComposeProblem::Characters.sentence(),
            "Use digits only, with an optional leading +"
        );
    }

    #[test]
    fn empty_recipient_has_the_fields_prompt() {
        assert_eq!(refusal("   "), ComposeProblem::EmptyRecipient);
        assert_eq!(
            ComposeProblem::EmptyRecipient.sentence(),
            "Enter the number to send to"
        );
    }

    #[test]
    fn empty_and_oversize_bodies_are_refused() {
        assert_eq!(check_body("   \n").unwrap_err(), ComposeProblem::EmptyBody);
        assert_eq!(
            ComposeProblem::EmptyBody.sentence(),
            "The message is empty"
        );

        let at_cap = "a".repeat(MAX_COMPOSE_BODY_CHARS);
        assert_eq!(check_body(&at_cap), Ok(()));

        let over = "a".repeat(MAX_COMPOSE_BODY_CHARS + 1);
        assert_eq!(
            check_body(&over).unwrap_err(),
            ComposeProblem::BodyTooLong(1601)
        );
        assert_eq!(
            ComposeProblem::BodyTooLong(1601).sentence(),
            "A message holds at most 1600 characters; this one has 1601"
        );
    }

    #[test]
    fn the_cap_counts_utf16_units_like_the_webview() {
        // 801 emoji is 1602 UTF-16 units but 801 scalar values: the same string
        // must be refused here as by `body.length > 1600` in the composer.
        let emoji = "😀".repeat(801);
        assert_eq!(body_chars(&emoji), 1602);
        assert_eq!(
            check_body(&emoji).unwrap_err(),
            ComposeProblem::BodyTooLong(1602)
        );
    }

    #[test]
    fn check_send_trims_and_checks_both_sides() {
        assert_eq!(check_send("  +8801540196080 ", "hello"), Ok("+8801540196080"));
        assert_eq!(check_send("bKash", "hello"), Err(ComposeProblem::Mask));
        assert_eq!(
            check_send("+8801540196080", "  "),
            Err(ComposeProblem::EmptyBody)
        );
    }
}
