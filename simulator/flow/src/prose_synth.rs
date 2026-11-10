//! By-example regex synthesis.
//!
//! An operator (or an agent) knows what the value looks like in two real
//! messages. Writing the pattern by hand means guessing at the label, the
//! separator and the shape of the value, and being wrong in a way that shows up
//! as a missing extraction three weeks later. This module derives the pattern
//! from the examples instead, and then PROVES it against them before returning
//! it.
//!
//! ## What it does
//!
//! 1. **Locate.** Each expected value must occur exactly once in its body. Twice
//!    is refused, not guessed: a pattern derived from an ambiguous span extracts
//!    the wrong number from half the traffic and there is no way to tell which
//!    half.
//! 2. **Anchor.** Walk back from the value: the trailing run of separator
//!    characters (`space`, tab, `:`, `=`) is the separator, and the label before
//!    it is the anchor. `Txn ID: ` anchors on `Txn ID`; the internal space is
//!    part of the label, not a word boundary.
//! 3. **Reconcile.** Across examples the anchors differ (`TrxID` and `Txn ID`),
//!    so they become a bounded alternation rather than a literal. Each
//!    alternative keeps its shape, with whitespace runs written as `\s+`.
//! 4. **Shape the value.** The common prefix and suffix of the values stay
//!    literal, and the middle becomes a character class with a length bound from
//!    what was seen.
//! 5. **Prove.** The pattern is compiled and run against every sample: exactly
//!    one match, and the captured group equals the expected value. Then the
//!    same on a negative corpus, where zero matches is the pass condition. Any
//!    failure refuses the synthesis instead of shipping a pattern that is mostly
//!    right.
//!
//! The result carries `precision` and `recall` measured on the corpus it was
//! given, because a synthesized pattern that reports only "ok" is a claim, and
//! the numbers are the evidence.

use serde::{Deserialize, Serialize};

/// How many distinct anchors before the examples stop describing one template.
const MAX_ANCHORS: usize = 6;
/// Longest label the walk-back will accept, in characters.
const MAX_ANCHOR_CHARS: usize = 32;
/// Longest separator run taken from a body.
const MAX_SEPARATOR_CHARS: usize = 4;

#[derive(Debug, Clone, Deserialize)]
pub struct Sample {
    pub body: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SynthRequest {
    pub samples: Vec<Sample>,
    /// Bodies the pattern must NOT match.
    #[serde(default)]
    pub negatives: Vec<String>,
    /// Capture-group name. Defaults to `value`.
    #[serde(default)]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SynthResult {
    /// The full pattern, capture group included.
    pub pattern: String,
    pub group: String,
    /// The label alternatives, as they appear in the pattern.
    pub anchors: Vec<String>,
    /// The separator class rendered after the anchor.
    pub separator: String,
    /// The value shape rendered after the separator.
    pub value_shape: String,
    /// Correct extractions / extractions attempted, on the samples given.
    pub precision: f64,
    /// Correct extractions / expected values, on the samples given.
    pub recall: f64,
    pub samples: usize,
    pub negatives: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SynthFailure {
    pub reason: String,
    pub message: String,
}

pub type SynthOutcome = Result<SynthResult, SynthFailure>;

fn fail(reason: &str, message: impl Into<String>) -> SynthOutcome {
    Err(SynthFailure {
        reason: reason.to_string(),
        message: message.into(),
    })
}

/* ------------------------------------------------------------------ label */

fn is_separator_char(ch: char) -> bool {
    ch == ' ' || ch == '\t' || ch == ':' || ch == '='
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// The label immediately before `start`, and the separator between them.
///
/// The walk-back takes a single trailing run of word characters, and allows one
/// space between two words so `Txn ID` stays one label. It stops at anything
/// else, which is what keeps a full sentence out of the anchor.
fn split_prefix(prefix: &str) -> (String, String) {
    let chars: Vec<char> = prefix.chars().collect();
    let mut index = chars.len();

    let mut separator_len = 0;
    while index > 0 && is_separator_char(chars[index - 1]) && separator_len < MAX_SEPARATOR_CHARS {
        index -= 1;
        separator_len += 1;
    }
    let separator: String = chars[index..].iter().collect();

    let end = index;
    let mut start = end;
    let mut chars_taken = 0;

    while start > 0 {
        let ch = chars[start - 1];
        if is_word_char(ch) {
            start -= 1;
            chars_taken += 1;
            continue;
        }
        // One internal space, and only when a word character precedes it: that is
        // what makes "Txn ID" one label instead of the word "ID".
        if ch == ' ' && start >= 2 && is_word_char(chars[start - 2]) {
            start -= 1;
            chars_taken += 1;
            continue;
        }
        break;
    }

    if chars_taken > MAX_ANCHOR_CHARS {
        start = end - MAX_ANCHOR_CHARS.min(chars_taken);
    }

    let anchor: String = chars[start..end].iter().collect();
    (anchor.trim().to_string(), separator)
}

/* ------------------------------------------------------------------ value */

#[derive(Debug, Clone, PartialEq)]
enum CharClass {
    Digits,
    Alnum,
    Hex,
    Mixed,
}

impl CharClass {
    fn render(&self) -> &'static str {
        match self {
            CharClass::Digits => "[0-9]",
            CharClass::Alnum => "[A-Za-z0-9]",
            CharClass::Hex => "[0-9A-Fa-f]",
            CharClass::Mixed => "[A-Za-z0-9._/-]",
        }
    }

    fn classify(values: &[&str]) -> CharClass {
        let mut digits = true;
        let mut alnum = true;
        let mut hex = true;
        let mut mixed = true;

        for value in values {
            for ch in value.chars() {
                if !ch.is_ascii_digit() {
                    digits = false;
                }
                if !ch.is_ascii_alphanumeric() {
                    alnum = false;
                }
                if !ch.is_ascii_hexdigit() {
                    hex = false;
                }
                if !(ch.is_ascii_alphanumeric() || "._/- ".contains(ch)) {
                    mixed = false;
                }
            }
        }

        // Most specific first: a value that is all digits IS alphanumeric, and
        // saying `[0-9]` is both tighter and more readable than `[A-Za-z0-9]`.
        if digits {
            CharClass::Digits
        } else if hex && !alnum {
            CharClass::Hex
        } else if alnum {
            CharClass::Alnum
        } else if mixed {
            CharClass::Mixed
        } else {
            CharClass::Mixed
        }
    }
}

fn common_prefix(values: &[&str]) -> String {
    let Some(first) = values.first() else {
        return String::new();
    };
    let mut end = first.len();
    for value in &values[1..] {
        let mut shared = 0;
        for (a, b) in first.chars().zip(value.chars()) {
            if a != b {
                break;
            }
            shared += a.len_utf8();
        }
        end = end.min(shared);
    }
    first[..end].to_string()
}

fn common_suffix(values: &[&str]) -> String {
    let Some(first) = values.first() else {
        return String::new();
    };
    let mut length = first.len();
    for value in &values[1..] {
        let mut shared = 0;
        for (a, b) in first.chars().rev().zip(value.chars().rev()) {
            if a != b {
                break;
            }
            shared += a.len_utf8();
        }
        length = length.min(shared);
    }
    let start = first.len().saturating_sub(length);
    first[start..].to_string()
}

/// Split the values into a literal head, a class in the middle, and a literal tail.
///
/// A SINGLE example has no head or tail to speak of: `common_prefix` of one value
/// is the whole value, and a pattern that only ever matches the message it was
/// derived from is not an extraction rule. So one sample is generalised over its
/// whole length, and the literals only appear once there are at least two values
/// that actually share them.
fn shape_value(values: &[&str]) -> Result<String, SynthFailure> {
    let mut head = if values.len() > 1 { common_prefix(values) } else { String::new() };
    let mut tail = if values.len() > 1 { common_suffix(values) } else { String::new() };

    // The head and the tail must not overlap, or the pattern would claim the same
    // characters twice.
    let shortest = values.iter().map(|value| value.chars().count()).min().unwrap_or(0);
    while head.chars().count() + tail.chars().count() > shortest {
        if tail.chars().count() >= head.chars().count() {
            let mut chars: Vec<char> = tail.chars().collect();
            chars.remove(0);
            tail = chars.into_iter().collect();
        } else {
            let mut chars: Vec<char> = head.chars().collect();
            chars.pop();
            head = chars.into_iter().collect();
        }
    }

    let owned: Vec<String> = values
        .iter()
        .map(|value| {
            let chars: Vec<char> = value.chars().collect();
            let head_len = head.chars().count();
            let tail_len = tail.chars().count();
            let end = chars.len().saturating_sub(tail_len);
            if end <= head_len {
                String::new()
            } else {
                chars[head_len..end].iter().collect()
            }
        })
        .collect();
    let middles: Vec<&str> = owned.iter().map(String::as_str).collect();

    let shortest_middle = middles.iter().map(|m| m.chars().count()).min().unwrap_or(0);
    let longest_middle = middles.iter().map(|m| m.chars().count()).max().unwrap_or(0);

    if longest_middle == 0 {
        // The values are identical or differ only by the literals: exact is right,
        // and a class would only loosen it.
        return Ok(format!("{}{}", escape(&head), escape(&tail)));
    }

    let class = CharClass::classify(&middles);
    // A range that is really one number is written as one number: `{7,7}` is
    // correct and reads like a machine wrote it.
    let quantifier = if shortest_middle == longest_middle {
        format!("{{{longest_middle}}}")
    } else {
        format!("{{{shortest_middle},{longest_middle}}}")
    };

    Ok(format!(
        "{}{}{}{}",
        escape(&head),
        class.render(),
        quantifier,
        escape(&tail)
    ))
}

/// Escape everything that is special in the `regex` crate's dialect.
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if "\\^$.|?*+()[]{}#&-~".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// A label rendered as a pattern: whitespace runs become `\s+`.
fn render_anchor(anchor: &str) -> String {
    let mut out = String::new();
    let mut on_space = false;
    for ch in anchor.chars() {
        if ch.is_whitespace() {
            if !on_space {
                out.push_str("\\s+");
                on_space = true;
            }
            continue;
        }
        on_space = false;
        if "\\^$.|?*+()[]{}#&-~".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/* --------------------------------------------------------------- synthesis */

/// Synthesize a pattern from examples, or say why it will not.
pub fn synthesize(request: &SynthRequest) -> SynthOutcome {
    if request.samples.is_empty() {
        return fail("no_samples", "at least one sample body/value pair is required");
    }

    let group = request
        .group
        .clone()
        .unwrap_or_else(|| "value".to_string());
    if !is_group_name(&group) {
        return fail(
            "bad_group",
            format!("'{group}' is not a usable capture-group name"),
        );
    }

    /* ---- 1. locate every value, refusing ambiguity --------------------- */
    let mut anchors: Vec<String> = Vec::new();
    for (index, sample) in request.samples.iter().enumerate() {
        if sample.value.is_empty() {
            return fail(
                "empty_value",
                format!("samples[{index}] has an empty value"),
            );
        }
        let hits = occurrences(&sample.body, &sample.value);
        match hits.len() {
            0 => {
                return fail(
                    "value_absent",
                    format!(
                        "samples[{index}]: '{}' does not appear in the body",
                        sample.value
                    ),
                )
            }
            1 => {}
            count => {
                return fail(
                    "value_ambiguous",
                    format!(
                        "samples[{index}]: '{}' appears {count} times in the body, so the span to anchor on is ambiguous",
                        sample.value
                    ),
                )
            }
        }
        let start = hits[0];
        let prefix: String = sample.body[..start].to_string();
        let (anchor, _separator) = split_prefix(&prefix);
        if anchor.is_empty() {
            return fail(
                "no_anchor",
                format!(
                    "samples[{index}]: there is nothing before the value to anchor on"
                ),
            );
        }
        if !anchors.contains(&anchor) {
            anchors.push(anchor);
        }
    }

    if anchors.len() > MAX_ANCHORS {
        return fail(
            "too_many_anchor_variants",
            format!(
                "the examples name {} different labels ({}), which is more than one template",
                anchors.len(),
                anchors.join(", ")
            ),
        );
    }

    /* ---- 2/3. reconcile into one labelled prefix ----------------------- */
    let rendered: Vec<String> = anchors.iter().map(|anchor| render_anchor(anchor)).collect();
    let anchor_pattern = if rendered.len() == 1 {
        rendered[0].clone()
    } else {
        format!("(?:{})", rendered.join("|"))
    };
    // A label is followed by punctuation, not by more label: this is a small
    // fixed class on purpose, so a body that says `TrxID` then a newline then the
    // value still matches without teaching the pattern to accept prose.
    let separator = "[\\s:=]*";

    /* ---- 4. the value ------------------------------------------------ */
    let values: Vec<&str> = request.samples.iter().map(|s| s.value.as_str()).collect();
    let value_shape = shape_value(&values)?;

    let pattern = format!("{anchor_pattern}{separator}(?<{group}>{value_shape})");

    /* ---- 5. prove it -------------------------------------------------- */
    let compiled = match regex::RegexBuilder::new(&pattern)
        .size_limit(1 << 20)
        .build()
    {
        Ok(regex) => regex,
        Err(error) => {
            return fail(
                "pattern_invalid",
                format!("the synthesized pattern does not compile: {error}"),
            )
        }
    };

    let mut attempted = 0usize;
    let mut correct = 0usize;
    for (index, sample) in request.samples.iter().enumerate() {
        let mut found: Vec<&str> = compiled
            .captures_iter(&sample.body)
            .filter_map(|captures| captures.name(&group).map(|m| m.as_str()))
            .collect();
        attempted += found.len().max(1);
        if found.len() == 1 && found[0] == sample.value {
            correct += 1;
        } else {
            return fail(
                "verification_failed",
                format!(
                    "samples[{index}]: the pattern would extract {:?}, not '{}'",
                    found.first().copied().unwrap_or("<nothing>"),
                    sample.value
                ),
            );
        }
        found.clear();
    }

    for (index, body) in request.negatives.iter().enumerate() {
        if compiled.is_match(body) {
            return fail(
                "negative_matched",
                format!("negatives[{index}]: the pattern matches a body it must not"),
            );
        }
    }

    let total = request.samples.len();
    Ok(SynthResult {
        pattern,
        group,
        anchors,
        separator: separator.to_string(),
        value_shape,
        precision: correct as f64 / attempted.max(1) as f64,
        recall: correct as f64 / total.max(1) as f64,
        samples: total,
        negatives: request.negatives.len(),
    })
}

fn is_group_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    name.len() <= 32 && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// Byte offsets of every non-overlapping occurrence.
fn occurrences(haystack: &str, needle: &str) -> Vec<usize> {
    let mut hits = Vec::new();
    let mut from = 0usize;
    while let Some(found) = haystack[from..].find(needle) {
        let at = from + found;
        hits.push(at);
        from = at + needle.len().max(1);
        if hits.len() > 8 {
            break;
        }
    }
    hits
}

/* ------------------------------------------------------------------ tests */

/* ------------------------------------------------------------------ pre-normalizer & bangla */

/// Convert fullwidth Latin/digits and Bangla digits U+09E6..U+09EF (০..৯) to ASCII digits/letters.
pub fn normalize_bangla_digits(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            '\u{09E6}'..='\u{09EF}' => ((ch as u32 - 0x09E6) as u8 + b'0') as char,
            // Fullwidth digits ０-９ (U+FF10..U+FF19)
            '\u{FF10}'..='\u{FF19}' => ((ch as u32 - 0xFF10) as u8 + b'0') as char,
            // Fullwidth Latin uppercase Ａ-Ｚ (U+FF21..U+FF3A)
            '\u{FF21}'..='\u{FF3A}' => ((ch as u32 - 0xFF21) as u8 + b'A') as char,
            // Fullwidth Latin lowercase ａ-ｚ (U+FF41..U+FF5A)
            '\u{FF41}'..='\u{FF5A}' => ((ch as u32 - 0xFF41) as u8 + b'a') as char,
            _ => ch,
        })
        .collect()
}

/// Detect if text contains OTP, PIN, or verification code keywords in English or Bangla.
/// Hardened per INFO-PBE-02: normalizes fullwidth characters and Bangla digits before matching,
/// recognizes extended Bengali keywords, and uses word-boundary token checks to prevent false positives.
pub fn is_otp_or_pin(input: &str) -> bool {
    let normalized = normalize_bangla_digits(input).to_lowercase();

    // Bangla sensitive keywords
    if normalized.contains("ওটিপি")
        || normalized.contains("ভেরিফিকেশন কোড")
        || normalized.contains("ভেরিফিকেশন")
        || normalized.contains("গোপন নম্বর")
        || normalized.contains("গোপন পিন")
        || normalized.contains("সিকিউরিটি কোড")
        || normalized.contains("গোলাপী পিন")
    {
        return true;
    }

    // Check single Bangla word 'পিন' on word boundary / whitespace
    for token in normalized.split(|c: char| c.is_whitespace() || c.is_ascii_punctuation()) {
        if token == "পিন" {
            return true;
        }
    }

    // English compound phrases
    let compound_phrases = [
        "verification code",
        "security code",
        "secret code",
        "one time password",
        "one-time password",
        "auth code",
        "authentication code",
    ];
    for phrase in &compound_phrases {
        if normalized.contains(phrase) {
            return true;
        }
    }

    // English single words (word-boundary checked to prevent false positives on 'opinion', 'spin', etc.)
    let single_words = ["otp", "pin", "passcode"];
    for token in normalized.split(|c: char| !c.is_alphanumeric()) {
        for word in &single_words {
            if token == *word {
                return true;
            }
        }
    }

    false
}

/// Normalize SMS text: converts Bangla digits to ASCII and collapses whitespace runs.
pub fn normalize_sms_body(input: &str) -> String {
    let converted = normalize_bangla_digits(input);
    let mut out = String::with_capacity(converted.len());
    let mut on_whitespace = false;
    for ch in converted.chars() {
        if ch.is_whitespace() {
            if !on_whitespace {
                out.push(' ');
                on_whitespace = true;
            }
        } else {
            out.push(ch);
            on_whitespace = false;
        }
    }
    out.trim().to_string()
}

/* ------------------------------------------------------------------ template workbench types */

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TemplateSpan {
    pub role: String, // "trigger", "extract", "ignore"
    pub name: String,
    #[serde(default)]
    pub slot_type: Option<String>,
    pub start: usize,
    pub end: usize,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TemplateRequest {
    pub sample_body: String,
    pub spans: Vec<TemplateSpan>,
    #[serde(default)]
    pub additional_samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateTestMatch {
    pub body: String,
    pub matched: bool,
    pub extracted: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateResult {
    pub pattern: String,
    pub trigger_phrases: Vec<String>,
    pub variables: Vec<String>,
    pub test_results: Vec<TemplateTestMatch>,
}

fn slot_regex_for(slot_type: &str) -> &'static str {
    match slot_type {
        "money_bdt" => r"[0-9]+(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?",
        "phone_bd" => r"(?:\+?88)?01[3-9][0-9]{8}(?:[0-9])?",
        "bank_account" => r"(?:\*+[0-9]{3,6}|[0-9]{10,17})",
        "trx_id" => r"[A-Z0-9]{6,16}",
        "datetime_bd" => r"[0-9]{1,2}[/-](?:[0-9]{1,2}|[A-Za-z]{3})[/-][0-9]{2,4}\s+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:\s*[apAP][mM])?",
        "number" => r"[0-9]+(?:\.[0-9]+)?",
        "free_text" => r"[^\.\r\n]{1,64}?",
        _ => r"[^\.\r\n]{1,64}?",
    }
}

/// Synthesize a template from highlighted spans.
pub fn synthesize_template(request: &TemplateRequest) -> Result<TemplateResult, SynthFailure> {
    let raw_sample = &request.sample_body;
    let sample = normalize_sms_body(raw_sample);
    let chars: Vec<char> = sample.chars().collect();

    if chars.is_empty() {
        return Err(SynthFailure {
            reason: "empty_sample".to_string(),
            message: "sample body cannot be empty".to_string(),
        });
    }

    let mut spans = request.spans.clone();
    spans.sort_by_key(|s| s.start);

    let mut pattern = String::new();
    let mut trigger_phrases = Vec::new();
    let mut variables = Vec::new();
    let mut last_end = 0;

    for span in &spans {
        let s_start = span.start.min(chars.len());
        let s_end = span.end.min(chars.len());
        if s_start > s_end || s_start < last_end {
            continue; // Skip invalid or overlapping
        }

        // Anchor before this span
        if s_start > last_end {
            let anchor_text: String = chars[last_end..s_start].iter().collect();
            let rendered = render_anchor(&anchor_text);
            if span.optional {
                // If optional, include anchor inside the optional group
                let slot_type = span.slot_type.as_deref().unwrap_or("free_text");
                let sub_pat = slot_regex_for(slot_type);
                pattern.push_str(&format!("(?:{rendered}(?<{}>{}))?", span.name, sub_pat));
                if !variables.contains(&span.name) {
                    variables.push(span.name.clone());
                }
                last_end = s_end;
                continue;
            } else {
                pattern.push_str(&rendered);
            }
        }

        let span_text: String = chars[s_start..s_end].iter().collect();
        match span.role.as_str() {
            "trigger" => {
                let rendered = render_anchor(&span_text);
                pattern.push_str(&rendered);
                if !trigger_phrases.contains(&span_text) {
                    trigger_phrases.push(span_text);
                }
            }
            "ignore" => {
                pattern.push_str(r"(?:[^\.\r\n]*?)");
            }
            "extract" => {
                let slot_type = span.slot_type.as_deref().unwrap_or("free_text");
                let sub_pat = slot_regex_for(slot_type);
                if span.optional {
                    pattern.push_str(&format!("(?:(?<{}>{}))?", span.name, sub_pat));
                } else {
                    pattern.push_str(&format!("(?<{}>{})", span.name, sub_pat));
                }
                if !variables.contains(&span.name) {
                    variables.push(span.name.clone());
                }
            }
            _ => {
                pattern.push_str(&escape(&span_text));
            }
        }
        last_end = s_end;
    }

    if last_end < chars.len() {
        let trailing: String = chars[last_end..].iter().collect();
        pattern.push_str(&render_anchor(&trailing));
    }

    if pattern.is_empty() {
        pattern = escape(&sample);
    }

    // Validate regex compilation
    let regex = match regex::RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
    {
        Ok(re) => re,
        Err(e) => {
            return Err(SynthFailure {
                reason: "invalid_pattern".to_string(),
                message: format!("synthesized pattern failed compilation: {e}"),
            });
        }
    };

    // Run tests against sample and additional samples
    let mut test_corpus = vec![sample.clone()];
    for extra in &request.additional_samples {
        let norm = normalize_sms_body(extra);
        if !test_corpus.contains(&norm) {
            test_corpus.push(norm);
        }
    }

    let mut test_results = Vec::new();
    for body in test_corpus {
        if let Some(captures) = regex.captures(&body) {
            let mut extracted = std::collections::BTreeMap::new();
            for name in regex.capture_names().flatten() {
                if let Some(m) = captures.name(name) {
                    let mut val = m.as_str().to_string();
                    if name == "amount" || name.ends_with("_amount") {
                        val = val.replace(',', "").trim().to_string();
                    }
                    extracted.insert(name.to_string(), val);
                }
            }
            test_results.push(TemplateTestMatch {
                body,
                matched: true,
                extracted,
            });
        } else {
            test_results.push(TemplateTestMatch {
                body,
                matched: false,
                extracted: std::collections::BTreeMap::new(),
            });
        }
    }

    Ok(TemplateResult {
        pattern,
        trigger_phrases,
        variables,
        test_results,
    })
}

/// Auto-suggest variable spans across a raw message body for sub-2-minute onboarding.
pub fn auto_suggest_spans(body: &str) -> Vec<TemplateSpan> {
    let mut spans = Vec::new();
    let norm = normalize_bangla_digits(body);

    // 1. Trigger phrases
    let triggers = [
        "You have received",
        "Cash In",
        "Payment to",
        "Money Received",
        "Deposit of",
    ];
    for trig in &triggers {
        if let Some(pos) = norm.find(trig) {
            spans.push(TemplateSpan {
                role: "trigger".to_string(),
                name: "trigger".to_string(),
                slot_type: None,
                start: pos,
                end: pos + trig.len(),
                optional: false,
            });
            break;
        }
    }

    // 2. Phone numbers (013..019)
    if let Ok(re_phone) = regex::Regex::new(r"01[3-9][0-9]{8}") {
        for mat in re_phone.find_iter(&norm) {
            spans.push(TemplateSpan {
                role: "extract".to_string(),
                name: "sender_account".to_string(),
                slot_type: Some("phone_bd".to_string()),
                start: mat.start(),
                end: mat.end(),
                optional: false,
            });
        }
    }

    // 3. Amount after Tk / BDT / ৳
    if let Ok(re_amount) = regex::Regex::new(r"(?:Tk\.?|BDT|৳)\s*([0-9,]+(?:\.[0-9]{1,2})?)") {
        for cap in re_amount.captures_iter(&norm) {
            if let Some(m) = cap.get(1) {
                // Avoid matching Balance amounts
                let before = &norm[..cap.get(0).unwrap().start()];
                if !before.ends_with("Balance ") && !before.ends_with("Fee ") {
                    spans.push(TemplateSpan {
                        role: "extract".to_string(),
                        name: "amount".to_string(),
                        slot_type: Some("money_bdt".to_string()),
                        start: m.start(),
                        end: m.end(),
                        optional: false,
                    });
                }
            }
        }
    }

    // 4. TrxID / TxnID
    if let Ok(re_trx) = regex::Regex::new(r"(?:TrxID|TxnID|Txn ID|Trx ID)[:\s]+([A-Z0-9]{6,16})") {
        for cap in re_trx.captures_iter(&norm) {
            if let Some(m) = cap.get(1) {
                spans.push(TemplateSpan {
                    role: "extract".to_string(),
                    name: "trx_id".to_string(),
                    slot_type: Some("trx_id".to_string()),
                    start: m.start(),
                    end: m.end(),
                    optional: false,
                });
            }
        }
    }

    // 5. Ref
    if let Ok(re_ref) = regex::Regex::new(r"Ref\s+([A-Za-z0-9_-]+)") {
        for cap in re_ref.captures_iter(&norm) {
            if let Some(m) = cap.get(1) {
                spans.push(TemplateSpan {
                    role: "extract".to_string(),
                    name: "reference".to_string(),
                    slot_type: Some("free_text".to_string()),
                    start: m.start(),
                    end: m.end(),
                    optional: true,
                });
            }
        }
    }

    // 6. DateTime
    if let Ok(re_dt) = regex::Regex::new(r"([0-9]{2}/[0-9]{2}/[0-9]{4}\s+[0-9]{2}:[0-9]{2})") {
        for m in re_dt.find_iter(&norm) {
            spans.push(TemplateSpan {
                role: "extract".to_string(),
                name: "timestamp".to_string(),
                slot_type: Some("datetime_bd".to_string()),
                start: m.start(),
                end: m.end(),
                optional: false,
            });
        }
    }

    spans.sort_by_key(|s| s.start);
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(samples: &[(&str, &str)], negatives: &[&str]) -> SynthRequest {
        SynthRequest {
            samples: samples
                .iter()
                .map(|(body, value)| Sample {
                    body: body.to_string(),
                    value: value.to_string(),
                })
                .collect(),
            negatives: negatives.iter().map(|body| body.to_string()).collect(),
            group: Some("trx_id".to_string()),
        }
    }

    #[test]
    fn two_bkash_examples_synthesize_one_labelled_pattern() {
        let request = req(
            &[
                (
                    "You have received Tk 500.00 from 01712345678. TrxID: DHK1234ABC at 2026-11-01 10:22.",
                    "DHK1234ABC",
                ),
                (
                    "Payment of Tk 250.00 received. Txn ID= DHK5678XYZ on 01-11-2026.",
                    "DHK5678XYZ",
                ),
            ],
            &["Your daily limit is Tk 25000. Dial *247# for help."],
        );

        let result = synthesize(&request).expect("should synthesize");
        assert_eq!(result.anchors, vec!["TrxID", "Txn ID"]);
        assert_eq!(result.separator, "[\\s:=]*");
        assert!(
            result.pattern.starts_with("(?:TrxID|Txn\\s+ID)[\\s:=]*"),
            "got {}",
            result.pattern
        );
        assert!(result.pattern.contains("(?<trx_id>"));
        assert_eq!(result.precision, 1.0);
        assert_eq!(result.recall, 1.0);
        assert_eq!(result.negatives, 1);
    }

    #[test]
    fn one_example_has_a_literal_anchor_but_a_general_shape() {
        let request = req(
            &[("Order A1B2C3 confirmed.", "A1B2C3")],
            &[],
        );
        let result = synthesize(&request).expect("should synthesize");
        assert_eq!(result.anchors, vec!["Order"]);
        assert!(result.pattern.starts_with("Order[\\s:=]*"), "got {}", result.pattern);
        // The value is a shape, not the one string it was derived from: a pattern
        // that can only ever match its own example is not an extraction rule.
        assert!(!result.value_shape.contains("A1B2C3"), "got {}", result.value_shape);
        assert!(result.value_shape.contains("[A-Za-z0-9]"), "got {}", result.value_shape);
        assert_eq!(result.precision, 1.0);
    }

    #[test]
    fn a_value_that_appears_twice_is_refused_not_guessed() {
        let request = req(
            &[(
                "TrxID: DHK1234ABC. The code DHK1234ABC is final.",
                "DHK1234ABC",
            )],
            &[],
        );
        let failure = synthesize(&request).expect_err("ambiguity must be refused");
        assert_eq!(failure.reason, "value_ambiguous");
        assert!(failure.message.contains("2 times"), "{}", failure.message);
    }

    #[test]
    fn a_value_that_is_not_there_is_refused() {
        let failure = synthesize(&req(&[("nothing here", "ABC123")], &[]))
            .expect_err("a missing value cannot be anchored");
        assert_eq!(failure.reason, "value_absent");
    }

    #[test]
    fn a_negative_the_pattern_would_match_is_refused() {
        // Two examples, so the value generalises to a shape, and the negative is a
        // body that shape really does match. That is the case the gate exists for.
        let request = req(
            &[
                ("TrxID: DHK1234ABC", "DHK1234ABC"),
                ("TrxID: DHK5678XYZ", "DHK5678XYZ"),
            ],
            &["Another TrxID: DHK9999ZZZ arrived"],
        );
        let failure = synthesize(&request).expect_err("the negative corpus is a gate");
        assert_eq!(failure.reason, "negative_matched");
    }

    #[test]
    fn a_value_at_the_start_has_no_anchor() {
        let failure = synthesize(&req(&[("ABC123 arrived", "ABC123")], &[]))
            .expect_err("there is nothing to anchor on");
        assert_eq!(failure.reason, "no_anchor");
    }

    #[test]
    fn digits_stay_narrow() {
        let request = req(
            &[
                ("Your code is 483920.", "483920"),
                ("Your code is 119284.", "119284"),
            ],
            &[],
        );
        let result = synthesize(&request).expect("should synthesize");
        assert!(result.value_shape.contains("[0-9]"), "got {}", result.value_shape);
    }

    #[test]
    fn bangla_digits_normalizer_converts_correctly() {
        let input = "টাকা ৮০০.০০ from ০১৯৯৯৯৯৯৯৯৯";
        let out = normalize_bangla_digits(input);
        assert_eq!(out, "টাকা 800.00 from 01999999999");

        // Fullwidth Latin & digits conversion
        let fullwidth = "Your ＯＴＰ code is ５４３２";
        assert_eq!(normalize_bangla_digits(fullwidth), "Your OTP code is 5432");
    }

    #[test]
    fn otp_pin_guard_detects_sensitive_messages() {
        assert!(is_otp_or_pin("Your OTP is 483920. Do not share."));
        assert!(is_otp_or_pin("আপনার ওটিপি কোড হলো ১২৩৪৫৬"));
        assert!(is_otp_or_pin("Security code for login: 998811"));
        assert!(is_otp_or_pin("Your ＯＴＰ code is 88219"));
        assert!(is_otp_or_pin("আপনার গোপন নম্বর হলো ৫৪২১"));
        assert!(is_otp_or_pin("গোপন পিন কাউকে বলবেন না"));
        assert!(is_otp_or_pin("Your one-time password is 102938"));

        // Negative tests: words containing 'pin' or 'otp' as substrings should NOT trigger
        assert!(!is_otp_or_pin("You have received Tk 800.00 from 01999999999. TrxID 8G56H7J8K9"));
        assert!(!is_otp_or_pin("In my opinion, we should proceed with shipping"));
        assert!(!is_otp_or_pin("Shopping at Pinpoint store"));
    }

    #[test]
    fn auto_suggest_detects_bkash_spans() {
        let msg = "You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24";
        let spans = auto_suggest_spans(msg);
        assert!(!spans.is_empty());
        let names: Vec<&str> = spans.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"amount"));
        assert!(names.contains(&"sender_account"));
        assert!(names.contains(&"trx_id"));
    }

    #[test]
    fn synthesize_template_builds_matching_re2_pattern() {
        let msg = "You have received Tk 800.00 from 01999999999. TrxID 8G56H7J8K9 at 15/07/2026 11:24";
        let spans = auto_suggest_spans(msg);
        let req = TemplateRequest {
            sample_body: msg.to_string(),
            spans,
            additional_samples: vec![
                "You have received Tk 1,250.50 from 01812345678. TrxID 9K12L3M4N5 at 16/07/2026 12:00".to_string(),
            ],
        };
        let res = synthesize_template(&req).expect("template synthesis should succeed");
        assert!(!res.pattern.is_empty());
        assert!(res.variables.contains(&"amount".to_string()));
        assert!(res.variables.contains(&"sender_account".to_string()));
        assert!(res.variables.contains(&"trx_id".to_string()));
        assert_eq!(res.test_results.len(), 2);
        assert!(res.test_results[0].matched);
        assert!(res.test_results[1].matched);
        assert_eq!(res.test_results[0].extracted.get("amount").map(String::as_str), Some("800.00"));
        assert_eq!(res.test_results[1].extracted.get("amount").map(String::as_str), Some("1250.50"));
    }
}
