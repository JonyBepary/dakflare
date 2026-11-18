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

use std::collections::BTreeMap;

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
        } else {
            // The widest class the synthesizer emits: anything it could not
            // narrow to digits, hex or alphanumerics still needs coverage.
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
    // A reference is prose, not an identifier: `Ref CUS512.` and `Ref test
    // payment.` are the same field with a different number of words. Deriving a
    // fixed word shape from those two examples produced `[A-Za-z0-9]{6,13}`,
    // which then refused the second sample at verification time. When every
    // sample agrees on a reference label and at least one value is multi-word,
    // the bounded prose class is the honest shape.
    let reference_shape = anchors.len() == 1
        && is_reference_label(&anchors[0])
        && values.iter().any(|value| value.contains(' '));
    let value_shape = if reference_shape {
        REFERENCE_VALUE_CLASS.to_string()
    } else {
        shape_value(&values)?
    };

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

/* ------------------------------------------------------- reference clauses */

/// The character class a reference clause is allowed to take. It is bounded on
/// purpose: a reference is one line of a receipt (`CUS512`, `test payment`), not
/// prose, so the pattern must not be taught to swallow a whole sentence.
pub const REFERENCE_VALUE_CLASS: &str = "[A-Za-z0-9 _-]{1,40}";

/// Labels that introduce a reference clause, longest first so `Reference` is not
/// read as `Ref` followed by `erence`.
pub const REFERENCE_LABELS: [&str; 2] = ["Reference", "Ref"];

/// More samples than this stop describing one template.
pub const MAX_REFERENCE_SAMPLES: usize = 5;

/// A clause that some samples carry and others omit.
///
/// The motivating failure: three receipts arrived, two carrying `Ref CUS512.` and
/// `Ref test payment.` and one carrying no reference at all. A shape derived from
/// the values (`[A-Za-z0-9]{6,6}`) refuses `test payment`, and a shape derived
/// from the anchors treats `test payment` as a second label. Neither is the
/// field. The field is "an optional `Ref` clause whose value is a short run of
/// word characters and spaces", so that is what `pattern` says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReferenceClause {
    /// The literal label, as the samples spelled it (`Ref`).
    pub label: String,
    /// Capture-group name inside the clause (`ref`).
    pub group: String,
    /// The whole clause, ready to place in a larger template.
    pub pattern: String,
    /// True when at least one sample omitted the clause.
    pub optional: bool,
    /// Samples that carried a clause.
    pub with_clause: usize,
    /// Samples that did not.
    pub without_clause: usize,
}

/// True when a label introduces a reference clause (`Ref`, `Reference`).
pub fn is_reference_label(label: &str) -> bool {
    let trimmed = label.trim_end_matches([':', '.', ' ']);
    REFERENCE_LABELS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(trimmed))
}

/// Locate a reference clause in one body: `(label, value, ended_with_period)`.
fn reference_clause_in(body: &str) -> Option<(String, String, bool)> {
    for label in REFERENCE_LABELS {
        let mut from = 0usize;
        while let Some(found) = body[from..].find(label) {
            let at = from + found;
            from = at + label.len();

            // The label must stand alone: not `Refund`, not `Preference`.
            let before_ok = body[..at]
                .chars()
                .next_back()
                .map(|ch| !is_word_char(ch))
                .unwrap_or(true);
            let after_index = at + label.len();
            let after = body[after_index..].chars().next();
            if !before_ok || !matches!(after, Some(ch) if ch.is_whitespace() || ch == ':' || ch == '=') {
                continue;
            }

            let after_label = &body[after_index..];
            let separated = after_label.trim_start_matches([':', '=', ' ', '\t', '\n', '\r']);
            if separated.len() == after_label.len() {
                // Nothing separated the label from a value: not a clause.
                continue;
            }

            let collected: String = separated
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == ' ' || *ch == '_' || *ch == '-')
                .collect();
            let value = collected.trim_end();
            if value.is_empty() || value.chars().count() > 40 {
                continue;
            }
            let period = separated[value.len()..].trim_start().starts_with('.');
            return Some((label.to_string(), value.to_string(), period));
        }
    }
    None
}

/// Synthesize the optional reference clause described by a set of bodies.
///
/// Returns `None` when the bodies do not describe one: fewer than two samples
/// carry the clause, the labels disagree, or every clause has the same word
/// count (in which case the ordinary value-shape path is already right, and the
/// single-word case must stay unchanged).
pub fn synthesize_reference_clause(
    bodies: &[String],
    group: Option<&str>,
) -> Option<ReferenceClause> {
    if bodies.len() < 2 || bodies.len() > MAX_REFERENCE_SAMPLES {
        return None;
    }
    let group = group.unwrap_or("ref");
    if !is_group_name(group) {
        return None;
    }

    let mut label: Option<String> = None;
    let mut texts: Vec<String> = Vec::new();
    let mut with_clause = 0usize;
    let mut period_count = 0usize;

    for body in bodies {
        let Some((found, text, period)) = reference_clause_in(body) else {
            continue;
        };
        match &label {
            Some(existing) if existing != &found => return None,
            Some(_) => {}
            None => label = Some(found),
        }
        with_clause += 1;
        if period {
            period_count += 1;
        }
        texts.push(text);
    }

    let label = label?;
    if with_clause < 2 {
        return None;
    }

    // Differing word counts are the evidence that a fixed shape is wrong. One
    // word everywhere (`CUS512`, `CUS999`) is the ordinary case.
    let word_counts: Vec<usize> = texts
        .iter()
        .map(|text| text.split_whitespace().count())
        .collect();
    if word_counts.iter().min() == word_counts.iter().max() {
        return None;
    }

    let optional = with_clause < bodies.len();
    let trailing = if period_count == with_clause { "\\." } else { "" };
    let pattern = format!(
        "(?: {label} (?<{group}>{REFERENCE_VALUE_CLASS}){trailing}){}",
        if optional { "?" } else { "" }
    );

    Some(ReferenceClause {
        label,
        group: group.to_string(),
        pattern,
        optional,
        with_clause,
        without_clause: bodies.len() - with_clause,
    })
}

/* ------------------------------------------------------------ role aliases */

/// Capture-group name to role name, e.g. `{"amount": "principal_amount"}`.
///
/// The synthesizers name what they see (`amount` for the first money span); a
/// caller's template may name the same slot by its role. Keeping the map
/// separate means the detector stays honest about what it looked at while the
/// caller still gets the names its graphs use.
pub type RoleAliases = BTreeMap<String, String>;

/// The alias map a first-run console starts with.
pub fn default_role_aliases() -> RoleAliases {
    let mut map = RoleAliases::new();
    map.insert("amount".to_string(), "principal_amount".to_string());
    map.insert("reference".to_string(), "reference".to_string());
    map.insert("sender_account".to_string(), "sender_account".to_string());
    map.insert("timestamp".to_string(), "timestamp".to_string());
    map.insert("trx_id".to_string(), "trx_id".to_string());
    map
}

/// Rename the spans through a role map, keeping capture-group names unique.
pub fn apply_role_aliases(spans: &mut [TemplateSpan], aliases: &RoleAliases) {
    for span in spans.iter_mut() {
        if let Some(replacement) = aliases.get(&span.name) {
            span.name = replacement.clone();
        }
    }
    dedupe_span_names(spans);
}

/// `amount`, `amount_2`, `amount_3`, ... in document order.
fn dedupe_span_names(spans: &mut [TemplateSpan]) {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for span in spans.iter_mut() {
        let count = seen.entry(span.name.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            span.name = format!("{}_{}", span.name, *count);
        }
    }
}

/* --------------------------------------------------------- literal segments */

/// One literal run in a pattern, and whether a value gap precedes it.
///
/// This is the small IR the diagnostics walk: enough to say where a message
/// stopped agreeing with a pattern, not a regex parser. Anything the scanner does
/// not understand becomes a gap, which is the safe direction — a gap means "the
/// pattern does not spell out what sits here", never "this must be literal".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiteralSegment {
    pub text: String,
    /// A class, group, quantifier or alternation sits between this segment and
    /// the previous one, so a value of unknown length lives in the gap.
    pub after_gap: bool,
}

fn flush_segment(out: &mut Vec<LiteralSegment>, current: &mut String, gap: bool) {
    if !current.is_empty() {
        out.push(LiteralSegment {
            text: std::mem::take(current),
            after_gap: gap,
        });
    }
}

/// Walk a pattern and return its literal runs in order.
pub fn literal_segments(pattern: &str) -> Vec<LiteralSegment> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out: Vec<LiteralSegment> = Vec::new();
    let mut current = String::new();
    let mut gap = false;
    let mut index = 0usize;

    // A character class or an escape that stands for one.
    fn is_class_escape(ch: char) -> bool {
        matches!(ch, 'd' | 'D' | 's' | 'S' | 'w' | 'W' | 'b' | 'B' | 'A' | 'z' | 'Z' | 'p' | 'P' | 'k' | 'K')
    }

    while index < chars.len() {
        let ch = chars[index];
        match ch {
            '\\' => {
                let Some(next) = chars.get(index + 1).copied() else {
                    index += 1;
                    continue;
                };
                if is_class_escape(next) {
                    flush_segment(&mut out, &mut current, gap);
                    gap = true;
                } else if next.is_ascii_alphanumeric() {
                    // `\n`, `\t`, `\r` are the escapes that stand for a literal
                    // control character; the rest were handled above.
                    current.push(match next {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        other => other,
                    });
                } else {
                    // Escaped punctuation is exactly that punctuation.
                    current.push(next);
                }
                index += 2;
            }
            '[' => {
                flush_segment(&mut out, &mut current, gap);
                gap = true;
                index += 1;
                if chars.get(index) == Some(&'^') {
                    index += 1;
                }
                if chars.get(index) == Some(&']') {
                    index += 1;
                }
                while index < chars.len() && chars[index] != ']' {
                    if chars[index] == '\\' {
                        index += 1;
                    }
                    index += 1;
                }
                index += 1;
            }
            '(' => {
                flush_segment(&mut out, &mut current, gap);
                gap = true;
                if chars.get(index + 1) == Some(&'?') {
                    let mut cursor = index + 2;
                    while cursor < chars.len() && chars[cursor] != ')' {
                        if chars[cursor] == '>' {
                            cursor += 1;
                            break;
                        }
                        if chars[cursor] == ':' {
                            cursor += 1;
                            break;
                        }
                        cursor += 1;
                    }
                    index = cursor;
                } else {
                    index += 1;
                }
            }
            ')' | '|' | '.' | '^' | '$' | '?' | '*' | '+' => {
                flush_segment(&mut out, &mut current, gap);
                gap = true;
                index += 1;
            }
            '{' => {
                flush_segment(&mut out, &mut current, gap);
                gap = true;
                index += 1;
                while index < chars.len() && chars[index] != '}' {
                    index += 1;
                }
                index += 1;
            }
            _ => {
                current.push(ch);
                index += 1;
            }
        }
    }

    flush_segment(&mut out, &mut current, gap);
    out
}

/* ------------------------------------------------------------------ tests */

/* ------------------------------------------------------------------ pre-normalizer & bangla */

fn normalize_char(ch: char) -> char {
    match ch {
        '\u{09E6}'..='\u{09EF}' => ((ch as u32 - 0x09E6) as u8 + b'0') as char,
        // Fullwidth digits ０-９ (U+FF10..U+FF19)
        '\u{FF10}'..='\u{FF19}' => ((ch as u32 - 0xFF10) as u8 + b'0') as char,
        // Fullwidth Latin uppercase Ａ-Ｚ (U+FF21..U+FF3A)
        '\u{FF21}'..='\u{FF3A}' => ((ch as u32 - 0xFF21) as u8 + b'A') as char,
        // Fullwidth Latin lowercase ａ-ｚ (U+FF41..U+FF5A)
        '\u{FF41}'..='\u{FF5A}' => ((ch as u32 - 0xFF41) as u8 + b'a') as char,
        _ => ch,
    }
}

/// Convert fullwidth Latin/digits and Bangla digits U+09E6..U+09EF (০..৯) to ASCII digits/letters.
pub fn normalize_bangla_digits(input: &str) -> String {
    input.chars().map(normalize_char).collect()
}

fn is_bangla_word_separator(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(
            c,
            '\u{0964}' // Devanagari/Bangla danda ।
            | '\u{0965}' // Double danda ॥
            | '\u{09FD}' // Bengali abbreviation sign ৽
            | '\u{09F3}' // Bengali rupee/taka sign ৳
            | '\u{2013}' // en dash –
            | '\u{2014}' // em dash —
            | '\u{2018}' // left single quote ‘
            | '\u{2019}' // right single quote ’
            | '\u{201C}' // left double quote “
            | '\u{201D}' // right double quote ”
            | '\u{2026}' // horizontal ellipsis …
            | '\u{00AB}' // «
            | '\u{00BB}' // »
            | '\u{200B}' // zero-width space
            | '\u{FEFF}' // BOM / zero-width no-break space
            | '\u{FF01}'..='\u{FF0F}' // fullwidth ! .. /
            | '\u{FF1A}'..='\u{FF20}' // fullwidth : .. @
            | '\u{FF3B}'..='\u{FF40}' // fullwidth [ .. `
            | '\u{FF5B}'..='\u{FF65}' // fullwidth { .. ･
        )
}

/// Detect if text contains OTP, PIN, or verification code keywords in English or Bangla.
/// Hardened per INFO-PBE-02: normalizes fullwidth characters and Bangla digits before matching,
/// recognizes extended Bengali keywords, and uses word-boundary token checks to prevent false positives.
pub fn is_otp_or_pin(input: &str) -> bool {
    let normalized = normalize_sms_body(input).to_lowercase();

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

    // Check single Bangla word 'পিন' on word boundary / separator.
    // Do NOT use `!c.is_alphanumeric()` here because Bangla combining marks like
    // U+09CD (virama '্') return false and would split conjunct words like "পিন্টু".
    for token in normalized.split(is_bangla_word_separator) {
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

fn normalize_sms_body_with_raw_map(raw: &str) -> (String, Vec<usize>) {
    let mut norm = String::with_capacity(raw.len());
    let mut raw_to_norm = Vec::with_capacity(raw.encode_utf16().count() + 1);
    let mut norm_char_len = 0usize;
    let mut saw_non_ws = false;
    let mut pending_space = false;

    for ch in raw.chars() {
        let u16_len = ch.len_utf16();
        if ch.is_whitespace() {
            if saw_non_ws {
                pending_space = true;
            }
            for _ in 0..u16_len {
                raw_to_norm.push(norm_char_len);
            }
        } else {
            if pending_space {
                norm.push(' ');
                norm_char_len += 1;
                pending_space = false;
            }
            for _ in 0..u16_len {
                raw_to_norm.push(norm_char_len);
            }
            norm.push(normalize_char(ch));
            norm_char_len += 1;
            saw_non_ws = true;
        }
    }
    raw_to_norm.push(norm_char_len);
    (norm, raw_to_norm)
}

fn normalize_sms_body_with_raw_spans(body: &str) -> (String, Vec<(usize, usize)>) {
    let mut norm = String::with_capacity(body.len());
    let mut norm_char_to_raw_u16 = Vec::new();
    let mut raw_u16 = 0usize;
    let mut saw_non_ws = false;
    let mut pending_ws: Option<(usize, usize)> = None;

    for ch in body.chars() {
        let u16_len = ch.len_utf16();
        let ch_start = raw_u16;
        let ch_end = raw_u16 + u16_len;
        raw_u16 = ch_end;

        if ch.is_whitespace() {
            if saw_non_ws {
                pending_ws = Some(match pending_ws {
                    Some((s, _)) => (s, ch_end),
                    None => (ch_start, ch_end),
                });
            }
        } else {
            if let Some(ws_span) = pending_ws.take() {
                norm.push(' ');
                norm_char_to_raw_u16.push(ws_span);
            }
            norm.push(normalize_char(ch));
            norm_char_to_raw_u16.push((ch_start, ch_end));
            saw_non_ws = true;
        }
    }
    (norm, norm_char_to_raw_u16)
}

/// Synthesize a template from highlighted spans.
pub fn synthesize_template(request: &TemplateRequest) -> Result<TemplateResult, SynthFailure> {
    let raw_sample = &request.sample_body;
    let (sample, raw_to_norm) = normalize_sms_body_with_raw_map(raw_sample);
    let chars: Vec<char> = sample.chars().collect();

    if chars.is_empty() {
        return Err(SynthFailure {
            reason: "empty_sample".to_string(),
            message: "sample body cannot be empty".to_string(),
        });
    }

    // Spans arrive as UTF-16 code unit offsets into the raw sample body (browser JS / flow-v2);
    // map them through `raw_to_norm` so leading/repeated whitespace and non-BMP emoji align cleanly.
    let max_u16 = raw_to_norm.len() - 1;
    let mut mapped_spans: Vec<(usize, usize, &TemplateSpan)> = request
        .spans
        .iter()
        .map(|s| {
            let start = raw_to_norm[s.start.min(max_u16)].min(chars.len());
            let end = raw_to_norm[s.end.min(max_u16)].min(chars.len());
            (start, end, s)
        })
        .collect();
    mapped_spans.sort_by_key(|(start, _, _)| *start);

    let mut pattern = String::new();
    let mut trigger_phrases = Vec::new();
    let mut variables = Vec::new();
    let mut last_end = 0;

    for &(s_start, s_end, span) in &mapped_spans {
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
///
/// Names are what the detectors saw (`amount`, `trx_id`); a caller that wants
/// role names applies [`default_role_aliases`] through
/// [`auto_suggest_spans_with_aliases`] instead.
pub fn auto_suggest_spans(body: &str) -> Vec<TemplateSpan> {
    let mut spans = detect_spans(body);
    dedupe_span_names(&mut spans);
    spans
}

/// Like [`auto_suggest_spans`], with the capture groups renamed through a role
/// map and kept unique afterwards.
pub fn auto_suggest_spans_with_aliases(body: &str, aliases: &RoleAliases) -> Vec<TemplateSpan> {
    let mut spans = detect_spans(body);
    apply_role_aliases(&mut spans, aliases);
    spans
}

fn detect_spans(body: &str) -> Vec<TemplateSpan> {
    let mut spans = Vec::new();
    let (norm, norm_char_to_raw_u16) = normalize_sms_body_with_raw_spans(body);

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

    // Map UTF-8 byte offsets in `norm` -> char offsets in `norm` -> raw UTF-16 offsets in `body`.
    let mut byte_to_char = vec![0usize; norm.len() + 1];
    let mut char_idx = 0usize;
    for (byte_idx, _) in norm.char_indices() {
        byte_to_char[byte_idx] = char_idx;
        char_idx += 1;
    }
    byte_to_char[norm.len()] = char_idx;

    for span in &mut spans {
        let char_start = byte_to_char[span.start];
        let char_end = byte_to_char[span.end];
        if char_end > char_start {
            span.start = norm_char_to_raw_u16[char_start].0;
            span.end = norm_char_to_raw_u16[char_end - 1].1;
        }
    }

    spans.sort_by_key(|s| s.start);

    // Two suggestions can name the same field: a bKash message has an amount and a
    // fee, and both look like money. `synthesize` refuses duplicate capture-group
    // names, correctly, so a caller that fed these straight in got
    // "duplicate capture group name" instead of a pattern. Suffixing in
    // `dedupe_span_names` keeps the suggestion useful and the contract honest,
    // and it runs after aliasing so a renamed span cannot collide either.
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
    fn suggestions_never_share_a_name() {
        // A bKash message has an amount and a fee; both are money, so the
        // detector proposes "amount" twice and `synthesize` then refuses the whole
        // set for a duplicate capture group. The suffix is what makes the
        // suggestion usable as-is.
        let msg = "You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24";
        let spans = auto_suggest_spans(msg);
        let mut names: Vec<&str> = spans.iter().map(|span| span.name.as_str()).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "two suggestions share a name");
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
        assert!(is_otp_or_pin("আপনার পিন। ১২৩৪"));
        assert!(is_otp_or_pin("আপনার পিন॥ ১২৩৪"));
        assert!(is_otp_or_pin("পিন—১২৩৪"));
        assert!(is_otp_or_pin("পিন：১২৩৪"));
        assert!(is_otp_or_pin("গোপন\nপিন কাউকে বলবেন না"));

        // Negative tests: words containing 'pin', 'otp', or conjunct 'পিন' should NOT trigger
        assert!(!is_otp_or_pin("You have received Tk 800.00 from 01999999999. TrxID 8G56H7J8K9"));
        assert!(!is_otp_or_pin("In my opinion, we should proceed with shipping"));
        assert!(!is_otp_or_pin("Shopping at Pinpoint store"));
        assert!(!is_otp_or_pin("পিন্টু আমাকে টাকা পাঠিয়েছে"));
        assert!(!is_otp_or_pin("আপিন"));
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

    /* ---- v7.1: the reference clause ---------------------------------- */

    #[test]
    fn three_samples_with_and_without_ref_get_one_optional_clause() {
        let bodies = vec![
            "Payment Tk 100.00 sent. Ref CUS512. Thank you.".to_string(),
            "Payment Tk 100.00 sent. Ref test payment. Thank you.".to_string(),
            "Payment Tk 100.00 sent. Thank you.".to_string(),
        ];

        let clause = synthesize_reference_clause(&bodies, Some("ref"))
            .expect("two word counts and one omission describe a clause");
        assert_eq!(clause.label, "Ref");
        assert_eq!(clause.group, "ref");
        assert!(clause.optional, "one sample omits the clause");
        assert_eq!(clause.with_clause, 2);
        assert_eq!(clause.without_clause, 1);
        assert_eq!(
            clause.pattern,
            r"(?: Ref (?<ref>[A-Za-z0-9 _-]{1,40})\.)?"
        );

        // The clause is a real pattern, not a description of one. It is optional,
        // so an unanchored search also finds the empty alternative first; a
        // caller embeds it between literals. Here, scan for the carrying match.
        let compiled = regex::Regex::new(&clause.pattern).expect("clause compiles");
        for body in &bodies {
            assert!(compiled.is_match(body), "clause must accept {body:?}");
        }
        let captured = |body: &str| -> Option<String> {
            compiled
                .captures_iter(body)
                .find_map(|captures| captures.name("ref").map(|m| m.as_str().to_string()))
        };
        assert_eq!(captured(&bodies[0]).as_deref(), Some("CUS512"));
        assert_eq!(captured(&bodies[1]).as_deref(), Some("test payment"));
        assert_eq!(captured(&bodies[2]), None, "the third sample has no reference");
    }

    #[test]
    fn a_multi_word_reference_keeps_all_of_its_words() {
        // The failure this exists for: `Ref CUS512.` and `Ref test payment.` used
        // to shape as `[A-Za-z0-9]{6,13}`, which then refused the second sample.
        let request = req(
            &[
                (
                    "You have received Tk 800.00. Ref CUS512. Fee Tk 0.00.",
                    "CUS512",
                ),
                (
                    "You have received Tk 800.00. Ref test payment. Fee Tk 0.00.",
                    "test payment",
                ),
            ],
            &[],
        );

        let result = synthesize(&request).expect("both samples describe one field");
        assert_eq!(result.anchors, vec!["Ref"]);
        assert_eq!(result.value_shape, REFERENCE_VALUE_CLASS);
        assert_eq!(result.precision, 1.0);
        assert_eq!(result.recall, 1.0);
        assert!(
            result.pattern.contains("[A-Za-z0-9 _-]{1,40}"),
            "got {}",
            result.pattern
        );
    }

    #[test]
    fn a_single_word_reference_case_is_unchanged() {
        // One word in every sample is the ordinary case: the value shape stays
        // narrow instead of widening to prose, and no clause is reported.
        let bodies = vec![
            "Payment Tk 100.00 sent. Ref CUS512. Thank you.".to_string(),
            "Payment Tk 100.00 sent. Ref CUS999. Thank you.".to_string(),
            "Payment Tk 100.00 sent. Ref INV033. Thank you.".to_string(),
        ];
        assert!(
            synthesize_reference_clause(&bodies, Some("ref")).is_none(),
            "a fixed word count is not a clause"
        );

        let request = req(
            &[
                ("Order sent. Ref CUS512.", "CUS512"),
                ("Order sent. Ref CUS999.", "CUS999"),
            ],
            &[],
        );
        let result = synthesize(&request).expect("single-word references still synthesize");
        assert_eq!(result.value_shape, "CUS[0-9]{3}");
        assert_ne!(result.value_shape, REFERENCE_VALUE_CLASS);
    }

    #[test]
    fn role_aliases_rename_without_colliding() {
        let message = "You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24";
        let aliases = default_role_aliases();
        assert_eq!(
            aliases.get("amount").map(String::as_str),
            Some("principal_amount")
        );

        let spans = auto_suggest_spans_with_aliases(message, &aliases);
        let mut names: Vec<&str> = spans.iter().map(|span| span.name.as_str()).collect();
        assert!(
            names.contains(&"principal_amount"),
            "the role map must reach the span: {names:?}"
        );
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "aliased names must stay unique");
    }

    #[test]
    fn synthesize_template_handles_bangla_and_emoji_utf16_offsets() {
        // Emojis occupy 2 UTF-16 code units; Bangla letters occupy 3 UTF-8 bytes and 1 UTF-16 unit.
        let body = "💰 টাকা 850.00 পেয়েছেন TrxID TX9988AA থেকে।";
        let amount_start = body[..body.find("850.00").unwrap()].encode_utf16().count();
        let amount_end = amount_start + "850.00".encode_utf16().count();
        let trx_start = body[..body.find("TX9988AA").unwrap()].encode_utf16().count();
        let trx_end = trx_start + "TX9988AA".encode_utf16().count();
        let req = TemplateRequest {
            sample_body: body.to_string(),
            spans: vec![
                TemplateSpan {
                    role: "extract".to_string(),
                    name: "amount".to_string(),
                    slot_type: Some("money_bdt".to_string()),
                    start: amount_start,
                    end: amount_end,
                    optional: false,
                },
                TemplateSpan {
                    role: "extract".to_string(),
                    name: "trx_id".to_string(),
                    slot_type: Some("trx_id".to_string()),
                    start: trx_start,
                    end: trx_end,
                    optional: false,
                },
            ],
            additional_samples: vec![
                "💰 টাকা 1,250.50 পেয়েছেন TrxID AB12CD34 থেকে।".to_string(),
            ],
        };
        let res = synthesize_template(&req).expect("emoji + Bangla UTF-16 offsets should succeed");
        assert_eq!(res.test_results[0].extracted.get("amount").map(String::as_str), Some("850.00"));
        assert_eq!(res.test_results[0].extracted.get("trx_id").map(String::as_str), Some("TX9988AA"));
        assert!(res.test_results[1].matched);
    }

    #[test]
    fn synthesize_template_handles_leading_and_repeated_whitespace_with_emoji_and_bangla() {
        // Challenger 1 Case C
        let body = "   💰   টাকা   850.00   পেয়েছেন   TrxID   TX9988AA";
        let amount_start = body[..body.find("850.00").unwrap()].encode_utf16().count();
        let amount_end = amount_start + "850.00".encode_utf16().count();
        let trx_start = body[..body.find("TX9988AA").unwrap()].encode_utf16().count();
        let trx_end = trx_start + "TX9988AA".encode_utf16().count();
        let req = TemplateRequest {
            sample_body: body.to_string(),
            spans: vec![
                TemplateSpan {
                    role: "extract".to_string(),
                    name: "amount".to_string(),
                    slot_type: Some("money_bdt".to_string()),
                    start: amount_start,
                    end: amount_end,
                    optional: false,
                },
                TemplateSpan {
                    role: "extract".to_string(),
                    name: "trx_id".to_string(),
                    slot_type: Some("trx_id".to_string()),
                    start: trx_start,
                    end: trx_end,
                    optional: false,
                },
            ],
            additional_samples: vec![
                "💰 টাকা 1,250.50 পেয়েছেন TrxID AB12CD34".to_string(),
            ],
        };
        let res = synthesize_template(&req).expect("leading/repeated whitespace + emoji UTF-16 offsets should succeed");
        assert!(res.test_results[0].matched, "pattern={}", res.pattern);
        assert_eq!(res.test_results[0].extracted.get("amount").map(String::as_str), Some("850.00"));
        assert_eq!(res.test_results[0].extracted.get("trx_id").map(String::as_str), Some("TX9988AA"));
        assert!(res.test_results[1].matched);
        assert_eq!(res.test_results[1].extracted.get("amount").map(String::as_str), Some("1250.50"));
        assert_eq!(res.test_results[1].extracted.get("trx_id").map(String::as_str), Some("AB12CD34"));
    }

    #[test]
    fn auto_suggest_spans_round_trips_into_synthesize_template_with_emojis_and_whitespace() {
        // Challenger 1 Case E + multi-whitespace + Bangla digits variant
        for body in [
            "💰🎉 You have received Tk 800.00 from 01999999999. TrxID 8G56H7J8K9",
            "   💰   You   have received Tk   800.00 from 01999999999. TrxID   8G56H7J8K9",
            "🎉🚀 ক্যাশ ইন টাকা ১,৫০০.০০ নম্বর ০১৭১২৩৪৫৬৭৮ TrxID BK998877।",
        ] {
            let spans = auto_suggest_spans(body);
            assert!(!spans.is_empty(), "expected spans for {body:?}");

            // Verify every returned span slices cleanly as UTF-16 code units in `body`.
            let utf16_units: Vec<u16> = body.encode_utf16().collect();
            for span in &spans {
                assert!(span.start < span.end && span.end <= utf16_units.len());
                let sliced = String::from_utf16(&utf16_units[span.start..span.end]).unwrap();
                assert!(!sliced.is_empty());
            }

            let req = TemplateRequest {
                sample_body: body.to_string(),
                spans,
                additional_samples: vec![],
            };
            let res = synthesize_template(&req).expect("round-trip synthesis should succeed");
            assert!(res.test_results[0].matched, "pattern={} body={:?}", res.pattern, body);
        }
    }
}
