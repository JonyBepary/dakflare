//! Corpus scoring for a self-healing pattern.
//!
//! A pattern that "works" is a claim. These numbers are the evidence: how much of
//! the corpus it extracts, how much of what it extracts was asked for, how much
//! of it is fixed literal rather than a wildcard, and how big the automaton it
//! implies would be. Selection then refuses a candidate that buys recall by
//! matching bodies it must not match.
//!
//! ## Determinism
//!
//! Everything here is a pure function of the pattern text and the corpus, in a
//! fixed order. Two runs over the same inputs produce the same scores, so
//! `dakflare` can show the ranking in a test report and a human can reproduce it.
//!
//! ## The complexity estimate is a proxy
//!
//! `dfa_complexity` is NOT a measured DFA. A real determinisation needs an
//! automata crate and can explode past any useful bound; this crate stays
//! dependency-light on purpose. The estimate counts the constructs that grow a
//! Thompson NFA — literal characters, alternation branches and character classes
//! — and divides by 2048, which is the budget a pattern is expected to stay
//! under. It is monotone in the right direction and stable, which is what
//! ranking needs, and it is documented as an estimate so nobody reads it as a
//! state count.

use regex::RegexBuilder;

/// State budget the complexity estimate is normalised against.
pub const DFA_STATE_BUDGET: f64 = 2048.0;

/// Bits of information a fixed character is assumed to carry at most: the width
/// of the printable-ASCII alphabet, `log2(95)`.
const MAX_BITS_PER_CHAR: f64 = 6.569_856;

#[derive(Debug, Clone, PartialEq)]
pub struct CorpusScore {
    /// Matched expected slots / expected.
    pub slot_recall: f64,
    /// Correct slots / produced slots.
    pub slot_precision: f64,
    /// Information-theoretic: fixed-token mass / regex length, in `0..=1`.
    pub specificity: f64,
    /// Estimated DFA states / [`DFA_STATE_BUDGET`], clamped to `0..=1`.
    pub dfa_complexity: f64,
    /// Negatives the pattern matched.
    pub false_positives: usize,
    /// `0.55 * recall + 0.30 * specificity - 0.15 * complexity`.
    pub combined: f64,
}

impl CorpusScore {
    /// A score that rejects the pattern it describes: used when the pattern does
    /// not compile, so callers never have to handle a `Result` they did not ask
    /// for.
    pub fn rejected() -> Self {
        Self {
            slot_recall: 0.0,
            slot_precision: 0.0,
            specificity: 0.0,
            dfa_complexity: 0.0,
            false_positives: 0,
            combined: 0.0,
        }
    }

    /// The documented weighting, unchanged.
    fn combine(recall: f64, specificity: f64, complexity: f64) -> f64 {
        0.55 * recall + 0.30 * specificity - 0.15 * complexity
    }
}

/* ------------------------------------------------------------------ scoring */

/// Score `regex` against a labelled corpus.
///
/// * `positives` — bodies the pattern should match and extract from.
/// * `negatives` — bodies it must not match at all.
/// * `expected_slots` — the capture-group names the pattern is supposed to
///   produce. A slot counts as recalled only when every positive yields a
///   non-empty value for it; anything produced that nobody asked for costs
///   precision.
///
/// An invalid pattern returns [`CorpusScore::rejected`] rather than panicking:
/// a caller ranking candidates is already handling "this one is bad".
pub fn evaluate_corpus_and_score(
    regex: &str,
    positives: &[String],
    negatives: &[String],
    expected_slots: &[String],
) -> CorpusScore {
    let compiled = match RegexBuilder::new(regex).size_limit(1 << 20).build() {
        Ok(compiled) => compiled,
        Err(_) => return CorpusScore::rejected(),
    };

    // Names that produced a value, and how many positives produced one. A slot
    // is recalled only when that count equals the whole positive corpus, so a
    // pattern that skips one message cannot hide behind the others.
    let mut produced: Vec<(String, usize)> = Vec::new();
    for body in positives {
        let Some(captures) = compiled.captures(body) else {
            continue;
        };
        for name in compiled.capture_names().flatten() {
            let Some(found) = captures.name(name) else {
                continue;
            };
            if found.as_str().is_empty() {
                continue;
            }
            match produced.iter_mut().find(|(known, _)| known == name) {
                Some((_, count)) => *count += 1,
                None => produced.push((name.to_string(), 1)),
            }
        }
    }

    let expected_total = expected_slots.len();
    let recalled = expected_slots
        .iter()
        .filter(|name| {
            !positives.is_empty()
                && produced
                    .iter()
                    .any(|(known, count)| known == *name && *count == positives.len())
        })
        .count();

    // Nothing was asked for and nothing was produced is a corpus with no slot
    // contract; nothing was asked for but something was produced is a surprise.
    let slot_recall = if expected_total == 0 {
        if produced.is_empty() { 1.0 } else { 0.0 }
    } else {
        recalled as f64 / expected_total as f64
    };

    let correct = produced
        .iter()
        .filter(|(name, _)| expected_slots.iter().any(|expected| expected == name))
        .count();
    let slot_precision = if produced.is_empty() {
        if expected_total == 0 { 1.0 } else { 0.0 }
    } else {
        correct as f64 / produced.len() as f64
    };

    let false_positives = negatives
        .iter()
        .filter(|body| compiled.is_match(body))
        .count();

    let shape = PatternShape::of(regex);

    CorpusScore {
        slot_recall,
        slot_precision,
        specificity: shape.specificity(),
        dfa_complexity: shape.dfa_complexity(),
        false_positives,
        combined: CorpusScore::combine(slot_recall, shape.specificity(), shape.dfa_complexity()),
    }
}

/// Keep the candidates that are strictly better than the pattern they replace,
/// best first.
///
/// A candidate is dropped when it matched a negative (`false_positives > 0`) or
/// when it lost recall against `old`. Both are refusals, not penalties: no amount
/// of specificity buys back an extraction the old pattern got right, and no
/// combined score buys back a false positive. The remainder is sorted by
/// `combined` descending, with the pattern text as the tie-break so the order is
/// reproducible.
pub fn rank_candidates(
    old: &CorpusScore,
    candidates: Vec<(String, CorpusScore)>,
) -> Vec<(String, CorpusScore)> {
    let mut kept: Vec<(String, CorpusScore)> = candidates
        .into_iter()
        .filter(|(_, candidate)| {
            candidate.false_positives == 0 && candidate.slot_recall >= old.slot_recall
        })
        .collect();

    kept.sort_by(|left, right| {
        right
            .1
            .combined
            .total_cmp(&left.1.combined)
            .then_with(|| left.0.cmp(&right.0))
    });
    kept
}

/* ------------------------------------------------------------ pattern shape */

/// What the estimate is built from: counts that grow a Thompson NFA.
#[derive(Debug, Clone, Copy, PartialEq)]
struct PatternShape {
    /// Fixed characters written in the pattern (escaped punctuation counts).
    literals: usize,
    /// `|` branches.
    alternations: usize,
    /// Character classes and class escapes (`\d`, `\s`, ...).
    classes: usize,
    /// Fixed-token mass in bits.
    fixed_bits: f64,
    /// Pattern length in characters.
    length: usize,
}

impl PatternShape {
    fn specificity(&self) -> f64 {
        if self.length == 0 {
            return 0.0;
        }
        let ceiling = self.length as f64 * MAX_BITS_PER_CHAR;
        (self.fixed_bits / ceiling).clamp(0.0, 1.0)
    }

    fn dfa_complexity(&self) -> f64 {
        let estimate = (self.literals + self.alternations + self.classes) as f64;
        (estimate / DFA_STATE_BUDGET).clamp(0.0, 1.0)
    }

    fn of(pattern: &str) -> Self {
        let chars: Vec<char> = pattern.chars().collect();
        let mut shape = PatternShape {
            literals: 0,
            alternations: 0,
            classes: 0,
            fixed_bits: 0.0,
            length: chars.len(),
        };
        let mut index = 0usize;

        while index < chars.len() {
            match chars[index] {
                '\\' => {
                    let Some(next) = chars.get(index + 1).copied() else {
                        index += 1;
                        continue;
                    };
                    if is_class_escape(next) {
                        shape.classes += 1;
                    } else if next.is_ascii_alphanumeric() {
                        // `\n`, `\t`, `\r` are fixed characters written the long
                        // way; the rest were counted as classes above.
                        shape.literals += 1;
                        shape.fixed_bits += bits_for(match next {
                            'n' => '\n',
                            't' => '\t',
                            'r' => '\r',
                            other => other,
                        });
                    } else {
                        shape.literals += 1;
                        shape.fixed_bits += bits_for(next);
                    }
                    index += 2;
                }
                '[' => {
                    shape.classes += 1;
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
                    // The group header is syntax, not a literal, and its name is
                    // metadata. Step over `(?P<name>` / `(?:` in one go.
                    if chars.get(index + 1) == Some(&'?') {
                        let mut cursor = index + 2;
                        while cursor < chars.len() && chars[cursor] != ')' {
                            if chars[cursor] == '>' || chars[cursor] == ':' {
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
                '|' => {
                    shape.alternations += 1;
                    index += 1;
                }
                '{' => {
                    index += 1;
                    while index < chars.len() && chars[index] != '}' {
                        index += 1;
                    }
                    index += 1;
                }
                '.' | '^' | '$' | '?' | '*' | '+' | ')' => {
                    index += 1;
                }
                literal => {
                    shape.literals += 1;
                    shape.fixed_bits += bits_for(literal);
                    index += 1;
                }
            }
        }

        shape
    }
}

fn is_class_escape(ch: char) -> bool {
    matches!(
        ch,
        'd' | 'D' | 's' | 'S' | 'w' | 'W' | 'b' | 'B' | 'A' | 'z' | 'Z' | 'p' | 'P' | 'k' | 'K'
    )
}

/// Bits one fixed character carries, by the alphabet it comes from.
fn bits_for(ch: char) -> f64 {
    if ch.is_ascii_digit() {
        10.0f64.log2()
    } else if ch.is_ascii_alphabetic() {
        26.0f64.log2()
    } else if ch.is_ascii() {
        32.0f64.log2()
    } else {
        // A non-ASCII literal is at least as wide as a byte's worth of choice;
        // counting it as 16 bits keeps scripts other than ASCII from scoring
        // artificially low.
        16.0
    }
}

/* ------------------------------------------------------------------ tests */

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn score(pattern: &str) -> CorpusScore {
        evaluate_corpus_and_score(
            pattern,
            &owned(&[
                "Payment sent. Ref CUS512.",
                "Payment sent. Ref test payment.",
            ]),
            &owned(&["Balance Tk 1,200.00 available."]),
            &owned(&["ref"]),
        )
    }

    #[test]
    fn a_pattern_that_extracts_everything_scores_well() {
        let scored = score(r"Ref[\s:=]*(?<ref>[A-Za-z0-9 _-]{1,40})");
        assert_eq!(scored.slot_recall, 1.0);
        assert_eq!(scored.slot_precision, 1.0);
        assert_eq!(scored.false_positives, 0);
        assert!(scored.specificity > 0.0 && scored.specificity <= 1.0);
        assert!(scored.dfa_complexity > 0.0 && scored.dfa_complexity < 0.1);
        assert!(
            (scored.combined - (0.55 + 0.30 * scored.specificity - 0.15 * scored.dfa_complexity))
                .abs()
                < 1e-12
        );
        assert!(scored.combined > 0.5, "got {}", scored.combined);
    }

    #[test]
    fn an_invalid_pattern_is_rejected_not_a_panic() {
        let scored = evaluate_corpus_and_score("(unclosed", &owned(&["x"]), &[], &owned(&["a"]));
        assert_eq!(scored, CorpusScore::rejected());
        assert_eq!(scored.combined, 0.0);
    }

    #[test]
    fn a_loose_pattern_produces_false_positives_and_loses_precision() {
        let scored = evaluate_corpus_and_score(
            r"(?<ref>[A-Za-z]+)\s+Tk\s+(?<stray>[0-9,]+)",
            &owned(&["Payment Tk 1,200.00 received."]),
            &owned(&["Balance Tk 0.00 available."]),
            &owned(&["ref"]),
        );
        assert!(scored.false_positives >= 1);
        assert_eq!(scored.slot_precision, 0.5, "the stray slot costs precision");
    }

    #[test]
    fn a_slot_that_one_positive_misses_is_not_recalled() {
        let scored = evaluate_corpus_and_score(
            r"Ref[\s:=]*(?<ref>CUS[0-9]+)",
            &owned(&["Ref CUS512.", "Ref INV999."]),
            &[],
            &owned(&["ref"]),
        );
        assert!(scored.slot_recall < 1.0, "got {}", scored.slot_recall);
    }

    #[test]
    fn ranking_rejects_false_positives_and_lost_recall() {
        let old = score(r"Ref[\s:=]*(?<ref>[A-Za-z0-9 _-]{1,40})");
        let better = CorpusScore {
            combined: 0.95,
            ..old.clone()
        };
        let mut false_positive = old.clone();
        false_positive.false_positives = 1;
        false_positive.combined = 0.99;
        let mut lost_recall = old.clone();
        lost_recall.slot_recall = 0.5;
        lost_recall.combined = 0.99;

        let ranked = rank_candidates(
            &old,
            vec![
                ("false-positive".to_string(), false_positive),
                ("lost-recall".to_string(), lost_recall),
                ("better".to_string(), better.clone()),
            ],
        );
        assert_eq!(ranked.len(), 1, "only the better candidate survives");
        assert_eq!(ranked[0].0, "better");
        assert_eq!(ranked[0].1.combined, 0.95);
    }

    #[test]
    fn ranking_is_ordered_by_combined_then_by_pattern() {
        let old = score(r"Ref[\s:=]*(?<ref>[A-Za-z0-9 _-]{1,40})");
        let candidate = |name: &str, combined: f64| {
            (
                name.to_string(),
                CorpusScore {
                    combined,
                    ..old.clone()
                },
            )
        };
        let ranked = rank_candidates(
            &old,
            vec![
                candidate("b", 0.7),
                candidate("a", 0.9),
                candidate("c", 0.7),
            ],
        );
        let names: Vec<&str> = ranked.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn a_tie_with_the_old_pattern_is_still_offered() {
        let old = score(r"Ref[\s:=]*(?<ref>[A-Za-z0-9 _-]{1,40})");
        let ranked = rank_candidates(&old, vec![("same".to_string(), old.clone())]);
        assert_eq!(ranked.len(), 1, "equal recall is not a regression");
    }

    #[test]
    fn complexity_is_clamped_and_monotone() {
        let small = score("Ref");
        let large = score(&"a".repeat(5000));
        assert!(large.dfa_complexity <= 1.0);
        assert!(large.dfa_complexity > small.dfa_complexity);
        assert!(small.dfa_complexity < 0.01, "got {}", small.dfa_complexity);
    }

    #[test]
    fn an_empty_corpus_has_no_slot_contract() {
        let scored = evaluate_corpus_and_score(r"^$", &[], &[], &[]);
        assert_eq!(scored.slot_recall, 1.0);
        assert_eq!(scored.slot_precision, 1.0);
    }
}
