//! The song as the renderer thinks about it: lines made of rows, rows made of word groups, groups
//! made of timed parts. Built from the `Lyric` array with the same rules the DOM renderer used, and
//! free of any browser type so it can be tested natively.

use crate::model::{Lyric, LyricPart, LyricsOptions, SyncType};
use crate::text;
use crate::theme::CommentSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
    Center,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Main,
    Background(u32),
    /// A timed romanization, drawn in the romanization pill and animated like the lyric.
    Romanization,
}

/// A timed word: one whitespace-free piece of a provider part.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub text: String,
    pub start_s: f32,
    pub duration_s: f32,
    pub row: usize,
    pub group: usize,
    pub background: bool,
    /// No duration of its own: it fades in rather than being swept.
    pub line_synced: bool,
    /// Held past `blyrics-long-word-threshold`.
    pub long_word: bool,
    /// Split into letters for the letter wave.
    pub lettered: bool,
    pub rtl: bool,
    pub explicit: bool,
}

impl Part {
    pub fn end_s(&self) -> f32 {
        self.start_s + self.duration_s
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub row: usize,
    pub kind: RowKind,
    /// Indices into `Line::parts`, in order.
    pub parts: Vec<usize>,
    pub background: bool,
    /// Longer than twice the wrap threshold: flows inline and may break between letters.
    pub long: bool,
    /// Preceded by a space in its row.
    pub spaced: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub kind: RowKind,
    /// Groups in order, each preceded by a space when `spaced` says so.
    pub groups: Vec<usize>,
    pub spaced_before: Vec<bool>,
    pub text: String,
    pub rtl: bool,
    /// Holds a right-to-left character, so its words flow as ordinary bidi text.
    pub bidi_sensitive: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub start_s: f32,
    pub duration_s: f32,
    pub agent: Option<String>,
    pub rtl: bool,
    pub instrumental: bool,
    pub blank: bool,
    pub lang: String,
    pub rows: Vec<Row>,
    pub groups: Vec<Group>,
    pub parts: Vec<Part>,
    pub translation: Option<(String, String)>,
    /// An untimed romanization, shown as plain text in the pill.
    pub romanization: Option<String>,
    /// Text the theme puts above the no-lyrics message (`--blyrics-no-lyrics-icon`).
    pub icon: Option<String>,
}

impl Line {
    pub fn end_s(&self) -> f32 {
        self.start_s + self.duration_s
    }

    pub fn align(&self) -> Align {
        match self.agent.as_deref() {
            Some("v2") | Some("v3") => Align::Right,
            Some("v1000") => Align::Center,
            _ if self.rtl => Align::Right,
            _ => Align::Left,
        }
    }

    pub fn has_text(&self) -> bool {
        !self.instrumental && !self.blank
    }
}

#[derive(Clone, Debug)]
pub struct Song {
    pub sync: SyncType,
    pub lines: Vec<Line>,
    pub credits: Option<String>,
    pub no_lyrics: bool,
}

/// What decorations the view shows from the lyrics' own fields, decided by the host.
#[derive(Clone, Copy, Debug, Default)]
pub struct Decorations {
    pub translations: bool,
    pub romanizations: bool,
}

/// Decorations a host hung on one line after the lyrics were given (`injectTranslation`,
/// `injectRomanization`). They are shown whatever `Decorations` says, take the place of the line's
/// own, and belong to the line: a swap that keeps the line, or rebuilds it in place, keeps them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Hung {
    /// Text and language.
    pub translation: Option<(String, String)>,
    /// Text, and the timed parts that sweep it, if it has any.
    pub romanization: Option<(String, Option<Vec<LyricPart>>)>,
}

pub fn build_song(
    lyrics: &[Lyric],
    hung: &[Hung],
    options: &LyricsOptions,
    settings: &CommentSettings,
    decorations: Decorations,
) -> Song {
    let sync = crate::model::detect_sync_type(lyrics, settings.disable_richsync);
    let langs = resolve_languages(lyrics, options.language.as_deref());
    let none = Hung::default();
    let mut lines: Vec<Line> = lyrics
        .iter()
        .enumerate()
        .map(|(index, lyric)| {
            build_line(lyric, hung.get(index).unwrap_or(&none), &langs[index], sync, settings, decorations)
        })
        .collect();
    inherit_instrumental_neighbours(lyrics, &mut lines);
    let credits = options
        .songwriters
        .as_ref()
        .filter(|names| !names.is_empty() && !options.no_lyrics && !settings.hide_credits)
        .map(|names| join_names(names));
    Song { sync, lines, credits, no_lyrics: options.no_lyrics }
}

fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} & {}", rest.join(", "), last),
    }
}

fn build_line(
    lyric: &Lyric,
    hung: &Hung,
    lang: &str,
    sync: SyncType,
    settings: &CommentSettings,
    decorations: Decorations,
) -> Line {
    let mut line = Line {
        start_s: (lyric.start_time_ms / 1000.0) as f32,
        duration_s: (lyric.duration_ms / 1000.0) as f32,
        agent: lyric.agent.clone().filter(|a| !a.is_empty()),
        rtl: text::first_strong_direction(&lyric.words) == Some(text::Direction::Rtl),
        instrumental: lyric.is_instrumental,
        blank: !lyric.is_instrumental && lyric.words.trim().is_empty(),
        lang: lang.to_string(),
        rows: Vec::new(),
        groups: Vec::new(),
        parts: Vec::new(),
        translation: None,
        romanization: None,
        icon: None,
    };
    if lyric.is_instrumental {
        return line;
    }

    let timed_parts = lyric.parts.as_ref().filter(|parts| !parts.is_empty() && sync == SyncType::Richsync);
    let parts: Vec<LyricPart> = match timed_parts {
        Some(parts) => parts.clone(),
        None => line_synced_parts(lyric, settings.line_synced_delay_ms),
    };
    let builder = RowBuilder::new(settings);
    builder.add_parts(&mut line, &parts, true);

    let (romanization, timed_romanization) = match &hung.romanization {
        Some((text, timed)) => (Some(text), timed.as_ref()),
        None if decorations.romanizations => (lyric.romanization.as_ref(), lyric.timed_romanization.as_ref()),
        None => (None, None),
    };
    let timed = timed_romanization.filter(|p| !p.is_empty() && sync == SyncType::Richsync);
    if let Some(parts) = timed {
        builder.add_romanization(&mut line, parts);
    } else if let Some(roman) = romanization.filter(|r| !r.trim().is_empty() && !same_text(r, &lyric.words)) {
        line.romanization = Some(roman.clone());
    }
    let translation = match &hung.translation {
        Some(hung) => Some(hung.clone()),
        None if decorations.translations => {
            lyric.translation.as_ref().map(|t| (t.text.clone(), t.lang.clone())).or_else(|| {
                lyric
                    .translations
                    .as_ref()
                    .and_then(|map| map.iter().next().map(|(lang, text)| (text.clone(), lang.clone())))
            })
        }
        None => None,
    };
    line.translation = translation.filter(|(text, _)| !text.trim().is_empty() && !same_text(text, &lyric.words));
    line
}

/// Where each line of a new song came from in the one it replaces: the old line's index, or `None`
/// for a line with no counterpart.
///
/// Lines equal in both, in the same order, are found first (a longest common subsequence); between
/// two of those, the lines that changed are paired off in order, so a line edited in place keeps
/// its place, and only what is left over is new or gone. This is the DOM renderer's swap: lines the
/// two share stay as they were, and a rebuilt line takes over the one it replaces.
pub fn match_lines<T: PartialEq>(old: &[T], new: &[T]) -> Vec<Option<usize>> {
    let (n, m) = (old.len(), new.len());
    // common[i][j]: the longest common subsequence of old[i..] and new[j..].
    let mut common = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            common[i][j] =
                if old[i] == new[j] { common[i + 1][j + 1] + 1 } else { common[i + 1][j].max(common[i][j + 1]) };
        }
    }
    let mut origins = vec![None; m];
    let (mut i, mut j) = (0, 0);
    // Unmatched runs since the last shared line, paired off when the next one is reached.
    let (mut old_run, mut new_run): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    let pair = |old_run: &mut Vec<usize>, new_run: &mut Vec<usize>, origins: &mut Vec<Option<usize>>| {
        for (&o, &n) in old_run.iter().zip(new_run.iter()) {
            origins[n] = Some(o);
        }
        old_run.clear();
        new_run.clear();
    };
    while i < n && j < m {
        if old[i] == new[j] {
            pair(&mut old_run, &mut new_run, &mut origins);
            origins[j] = Some(i);
            i += 1;
            j += 1;
        } else if common[i + 1][j] >= common[i][j + 1] {
            old_run.push(i);
            i += 1;
        } else {
            new_run.push(j);
            j += 1;
        }
    }
    old_run.extend(i..n);
    new_run.extend(j..m);
    pair(&mut old_run, &mut new_run, &mut origins);
    origins
}

/// Decorations equal to the lyric (ignoring case, punctuation and edges) are not shown.
fn same_text(a: &str, b: &str) -> bool {
    let normal = |s: &str| {
        s.to_lowercase()
            .chars()
            .filter(|c| !c.is_ascii_punctuation() && !is_unicode_punctuation(*c))
            .collect::<String>()
            .trim()
            .to_string()
    };
    normal(a) == normal(b)
}

fn is_unicode_punctuation(c: char) -> bool {
    matches!(c as u32, 0x2010..=0x2027 | 0x3000..=0x303F | 0xFF01..=0xFF0F | 0x00A1 | 0x00BF | 0x060C | 0x061F)
}

/// A lyric with no timed parts becomes one zero-duration part per word, a fixed delay apart.
fn line_synced_parts(lyric: &Lyric, delay_ms: f32) -> Vec<LyricPart> {
    let mut word_index = 0usize;
    split_whitespace_tokens(&lyric.words)
        .into_iter()
        .map(|token| {
            let space = token.chars().all(char::is_whitespace);
            let part = LyricPart {
                start_time_ms: lyric.start_time_ms + (word_index as f64) * delay_ms as f64,
                words: token.to_string(),
                duration_ms: 0.0,
                ..Default::default()
            };
            if !space {
                word_index += 1;
            }
            part
        })
        .collect()
}

/// `/\s+|\S+/gu`: alternating runs of whitespace and non-whitespace.
pub fn split_whitespace_tokens(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut current_space: Option<bool> = None;
    for (index, c) in text.char_indices() {
        let space = c.is_whitespace();
        if current_space.is_some_and(|s| s != space) {
            tokens.push(&text[start..index]);
            start = index;
        }
        current_space = Some(space);
    }
    if start < text.len() {
        tokens.push(&text[start..]);
    }
    tokens
}

/// A whitespace-free piece of a part, timed pro rata to its share of the part's characters.
struct Token<'a> {
    text: &'a str,
    space: bool,
    start_ms: f64,
    duration_ms: f64,
    background: bool,
    explicit: bool,
    background_group: u32,
    zero_duration: bool,
}

fn tokens_of(part: &LyricPart) -> Vec<Token<'_>> {
    let pieces = split_whitespace_tokens(&part.words);
    let length = |s: &str| s.encode_utf16().count() as f64;
    let spaces: f64 = pieces.iter().filter(|p| p.chars().all(char::is_whitespace)).map(|p| length(p)).sum();
    let non_space = (length(&part.words) - spaces).max(1.0);
    let mut cursor = 0.0;
    pieces
        .into_iter()
        .map(|piece| {
            let space = piece.chars().all(char::is_whitespace);
            let (start_ms, duration_ms) = if space {
                (part.start_time_ms, 0.0)
            } else {
                let start = (part.duration_ms * cursor / non_space).round();
                cursor += length(piece);
                let end = (part.duration_ms * cursor / non_space).round();
                (part.start_time_ms + start, end - start)
            };
            Token {
                text: piece,
                space,
                start_ms,
                duration_ms,
                background: part.is_background,
                explicit: part.explicit,
                background_group: part.background_group.unwrap_or(0),
                zero_duration: part.duration_ms == 0.0,
            }
        })
        .collect()
}

struct RowBuilder<'s> {
    settings: &'s CommentSettings,
}

impl<'s> RowBuilder<'s> {
    fn new(settings: &'s CommentSettings) -> Self {
        RowBuilder { settings }
    }

    fn row_for(line: &mut Line, kind: RowKind) -> usize {
        if let Some(index) = line.rows.iter().position(|row| row.kind == kind) {
            return index;
        }
        line.rows.push(Row {
            kind,
            groups: Vec::new(),
            spaced_before: Vec::new(),
            text: String::new(),
            rtl: false,
            bidi_sensitive: false,
        });
        line.rows.len() - 1
    }

    /// Adds a lyric's parts. With `split_background`, background parts go to their own rows, one per
    /// background group, after the main row.
    fn add_parts(&self, line: &mut Line, parts: &[LyricPart], split_background: bool) {
        Self::row_for(line, RowKind::Main);
        self.fill_rows(line, parts, |token| {
            if split_background && token.background {
                RowKind::Background(token.background_group)
            } else {
                RowKind::Main
            }
        });
        // Main first, then background rows by group number.
        line.rows.sort_by_key(|row| match row.kind {
            RowKind::Main => 0,
            RowKind::Background(group) => 1 + group as u64,
            RowKind::Romanization => u64::MAX,
        });
        for group in &mut line.groups {
            group.row = line.rows.iter().position(|row| row.kind == group.kind).unwrap_or(0);
        }
        for row in line.rows.iter_mut() {
            row.groups.clear();
            row.spaced_before.clear();
        }
        // Rebuild each row's group list from the groups, which kept their order and spacing.
        for (index, group) in line.groups.iter().enumerate() {
            let row = &mut line.rows[group.row];
            row.groups.push(index);
            row.spaced_before.push(group.spaced);
        }
        for part in &mut line.parts {
            part.row = line.groups[part.group].row;
        }
        self.finish_rows(line);
    }

    fn add_romanization(&self, line: &mut Line, parts: &[LyricPart]) {
        let first_group = line.groups.len();
        let row = Self::row_for(line, RowKind::Romanization);
        self.fill_rows(line, parts, |_| RowKind::Romanization);
        for group in &mut line.groups[first_group..] {
            group.row = row;
        }
        self.finish_rows(line);
    }

    fn fill_rows(&self, line: &mut Line, parts: &[LyricPart], kind_of: impl Fn(&Token) -> RowKind) {
        // A space is pending separately for every row, and only lands before a group in a row that
        // already holds something, so leading and trailing whitespace is dropped.
        let mut pending_space: Vec<(RowKind, bool)> = Vec::new();
        let mut open_group: Option<(usize, RowKind, bool, u32)> = None;
        for part in parts {
            for token in tokens_of(part) {
                if token.space {
                    open_group = None;
                    for kind in [RowKind::Main, RowKind::Romanization, RowKind::Background(token.background_group)] {
                        set_pending(&mut pending_space, kind, true);
                    }
                    for row in &line.rows {
                        set_pending(&mut pending_space, row.kind, true);
                    }
                    continue;
                }
                let kind = kind_of(&token);
                let row = Self::row_for(line, kind);
                let continues = open_group.is_some_and(|(_, k, bg, bg_group)| {
                    k == kind && bg == token.background && bg_group == token.background_group
                });
                let group = if continues {
                    open_group.unwrap().0
                } else {
                    let spaced = take_pending(&mut pending_space, kind) && !line.rows[row].groups.is_empty();
                    line.groups.push(Group {
                        row,
                        kind,
                        parts: Vec::new(),
                        background: token.background,
                        long: false,
                        spaced,
                    });
                    let group = line.groups.len() - 1;
                    line.rows[row].groups.push(group);
                    line.rows[row].spaced_before.push(spaced);
                    open_group = Some((group, kind, token.background, token.background_group));
                    group
                };
                let start_s = (token.start_ms / 1000.0) as f32;
                let duration_s = (token.duration_ms / 1000.0) as f32;
                line.parts.push(Part {
                    text: token.text.to_string(),
                    start_s,
                    duration_s,
                    row,
                    group,
                    background: token.background,
                    line_synced: token.zero_duration,
                    long_word: token.duration_ms > self.settings.long_word_threshold_ms as f64,
                    lettered: false,
                    explicit: token.explicit,
                    rtl: text::first_strong_direction(token.text) == Some(text::Direction::Rtl)
                        || token.text.chars().any(|c| text::char_direction(c) == Some(text::Direction::Rtl)),
                });
                line.groups[group].parts.push(line.parts.len() - 1);
            }
        }
    }

    /// Settles what depends on whole rows and groups: direction, bidi sensitivity, long groups and
    /// which parts split into letters.
    fn finish_rows(&self, line: &mut Line) {
        for row in &mut line.rows {
            let mut text = String::new();
            for (i, group) in row.groups.iter().enumerate() {
                if row.spaced_before[i] {
                    text.push(' ');
                }
                for &part in &line.groups[*group].parts {
                    text.push_str(&line.parts[part].text);
                }
            }
            row.rtl = text::first_strong_direction(&text) == Some(text::Direction::Rtl);
            row.bidi_sensitive = text.chars().any(|c| text::char_direction(c) == Some(text::Direction::Rtl));
            row.text = text;
        }
        let threshold = self.settings.long_word_wrap_threshold.max(1);
        for group in &mut line.groups {
            let text: String = group.parts.iter().map(|&p| line.parts[p].text.as_str()).collect();
            let units = text.encode_utf16().count();
            group.long = units > 2 * threshold && text::grapheme_ranges(&text).len() > 2 * threshold;
            let joining = text::has_joining_script(&text);
            let mixed = text::is_mixed_direction(&text);
            let lettered = self.settings.letter_wave && !joining && !mixed;
            for &p in &group.parts {
                line.parts[p].lettered = lettered;
            }
        }
    }
}

fn set_pending(pending: &mut Vec<(RowKind, bool)>, kind: RowKind, value: bool) {
    match pending.iter_mut().find(|(k, _)| *k == kind) {
        Some(entry) => entry.1 = value,
        None => pending.push((kind, value)),
    }
}

fn take_pending(pending: &mut [(RowKind, bool)], kind: RowKind) -> bool {
    match pending.iter_mut().find(|(k, _)| *k == kind) {
        Some(entry) => std::mem::replace(&mut entry.1, false),
        None => false,
    }
}

/// Instrumental lines take the agent and direction of the nearest sung line, looking forward first.
fn inherit_instrumental_neighbours(lyrics: &[Lyric], lines: &mut [Line]) {
    for (index, line) in lines.iter_mut().enumerate() {
        if !line.instrumental {
            continue;
        }
        let nearest = |want: &dyn Fn(usize) -> bool| -> Option<usize> {
            (index + 1..lyrics.len()).find(|&i| want(i)).or_else(|| (0..index).rev().find(|&i| want(i)))
        };
        let agent_source =
            nearest(&|i| !lyrics[i].is_instrumental && lyrics[i].agent.as_deref().is_some_and(|a| !a.is_empty()));
        let text_source = nearest(&|i| !lyrics[i].is_instrumental && !lyrics[i].words.trim().is_empty());
        line.agent = agent_source.and_then(|i| lyrics[i].agent.clone());
        line.rtl =
            text_source.is_some_and(|i| text::first_strong_direction(&lyrics[i].words) == Some(text::Direction::Rtl));
    }
}

/// The `lang` of every line: the source language, unless a line's own script says otherwise.
fn resolve_languages(lyrics: &[Lyric], source: Option<&str>) -> Vec<String> {
    let language = match source.map(str::trim) {
        None | Some("") | Some("auto") | Some("und") => String::new(),
        Some(lang) => lang.to_string(),
    };
    let hint = |lyric: &Lyric| -> Option<&'static str> {
        if lyric.is_instrumental {
            return None;
        }
        let kana = lyric.words.chars().any(|c| matches!(c as u32, 0x3040..=0x30FF | 0x31F0..=0x31FF));
        let hangul =
            lyric.words.chars().any(|c| matches!(c as u32, 0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F));
        if kana {
            Some("ja")
        } else if hangul {
            Some("ko")
        } else {
            None
        }
    };
    let hints: Vec<Option<&str>> = lyrics.iter().map(hint).collect();
    let mut distinct: Vec<&str> = hints.iter().flatten().copied().collect();
    distinct.sort();
    distinct.dedup();
    let song_hint = if distinct.len() == 1 { distinct[0] } else { "" };
    let is_cjk = |lang: &str| {
        let primary = lang.split('-').next().unwrap_or("");
        matches!(primary, "ja" | "ko" | "zh" | "yue") || lang.contains("-Hans") || lang.contains("-Hant")
    };
    let fallback = if is_cjk(&language) {
        language.clone()
    } else if !song_hint.is_empty() {
        song_hint.to_string()
    } else {
        language.clone()
    };
    lyrics
        .iter()
        .zip(hints)
        .map(|(lyric, hint)| {
            let has_han = lyric.words.chars().any(|c| matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF));
            if lyric.is_instrumental {
                String::new()
            } else if let Some(h) = hint.filter(|h| fallback.split('-').next() != Some(*h)) {
                h.to_string()
            } else if has_han && !is_cjk(&fallback) {
                String::new()
            } else {
                fallback.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(start: f64, words: &str, duration: f64) -> LyricPart {
        LyricPart { start_time_ms: start, words: words.into(), duration_ms: duration, ..Default::default() }
    }

    fn lyric(parts: Vec<LyricPart>) -> Lyric {
        let words = parts.iter().map(|p| p.words.as_str()).collect::<String>();
        Lyric {
            start_time_ms: parts[0].start_time_ms,
            words,
            duration_ms: 2000.0,
            parts: Some(parts),
            ..Default::default()
        }
    }

    #[test]
    fn syllables_join_into_one_group_and_spaces_split_groups() {
        let lyrics = vec![lyric(vec![
            part(0.0, "The ", 300.0),
            part(300.0, "ket", 200.0),
            part(500.0, "tle ", 300.0),
            part(800.0, "starts", 400.0),
        ])];
        let song =
            build_song(&lyrics, &[], &LyricsOptions::default(), &CommentSettings::default(), Decorations::default());
        let line = &song.lines[0];
        assert_eq!(song.sync, SyncType::Richsync);
        assert_eq!(line.parts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["The", "ket", "tle", "starts"]);
        assert_eq!(line.groups.len(), 3);
        assert_eq!(line.groups[1].parts, vec![1, 2]);
        assert_eq!(line.rows[0].spaced_before, vec![false, true, true]);
    }

    #[test]
    fn background_parts_get_their_own_row() {
        let mut bg = part(1000.0, "(let it land)", 900.0);
        bg.is_background = true;
        let lyrics = vec![lyric(vec![part(0.0, "land ", 500.0), bg])];
        let song =
            build_song(&lyrics, &[], &LyricsOptions::default(), &CommentSettings::default(), Decorations::default());
        let line = &song.lines[0];
        assert_eq!(line.rows.len(), 2);
        assert_eq!(line.rows[1].kind, RowKind::Background(0));
        let bg_parts: Vec<_> = line.parts.iter().filter(|p| p.background).map(|p| (p.text.as_str(), p.row)).collect();
        assert_eq!(bg_parts, [("(let", 1), ("it", 1), ("land)", 1)]);
        // Pro-rated by characters: "(let" is 4 of 11 non-space characters.
        let first = line.parts.iter().find(|p| p.text == "(let").unwrap();
        assert!((first.duration_s - 0.327).abs() < 0.002);
    }

    #[test]
    fn line_synced_words_are_staggered() {
        let lyrics =
            vec![Lyric { start_time_ms: 1000.0, words: "a b  c".into(), duration_ms: 2000.0, ..Default::default() }];
        let song =
            build_song(&lyrics, &[], &LyricsOptions::default(), &CommentSettings::default(), Decorations::default());
        let starts: Vec<f32> = song.lines[0].parts.iter().map(|p| p.start_s).collect();
        assert_eq!(starts, [1.0, 1.05, 1.1]);
        assert!(song.lines[0].parts.iter().all(|p| p.line_synced));
        assert_eq!(song.sync, SyncType::Synced);
    }

    #[test]
    fn credits_join_names() {
        assert_eq!(join_names(&["A".into(), "B".into(), "C".into()]), "A, B & C");
        assert_eq!(join_names(&["A".into(), "B".into()]), "A & B");
    }

    #[test]
    fn rtl_rows_are_bidi_sensitive_and_arabic_is_not_lettered() {
        let lyrics = vec![lyric(vec![part(0.0, "مرحبا ", 500.0), part(500.0, "world", 500.0)])];
        let song =
            build_song(&lyrics, &[], &LyricsOptions::default(), &CommentSettings::default(), Decorations::default());
        let line = &song.lines[0];
        assert!(line.rtl);
        assert!(line.rows[0].bidi_sensitive);
        assert!(!line.parts[0].lettered);
        assert!(line.parts[1].lettered);
    }

    #[test]
    fn a_swap_keeps_shared_lines_and_pairs_edited_ones_in_place() {
        // b was edited to B; x was inserted; d was dropped.
        let old = ["a", "b", "c", "d", "e"];
        let new = ["a", "B", "c", "x", "e"];
        assert_eq!(match_lines(&old, &new), vec![Some(0), Some(1), Some(2), Some(3), Some(4)]);

        let new = ["a", "x", "b", "c", "e"];
        assert_eq!(match_lines(&old, &new), vec![Some(0), None, Some(1), Some(2), Some(4)]);

        let new = ["c", "d", "e"];
        assert_eq!(match_lines(&old, &new), vec![Some(2), Some(3), Some(4)]);

        let new: [&str; 0] = [];
        assert!(match_lines(&old, &new).is_empty());
        assert_eq!(match_lines(&[] as &[&str], &["a"]), vec![None]);
    }

    #[test]
    fn hung_decorations_show_whatever_the_fields_say() {
        let lyrics =
            vec![Lyric { start_time_ms: 1000.0, words: "hola".into(), duration_ms: 1000.0, ..Default::default() }];
        let hung = vec![Hung { translation: Some(("hello".into(), "en".into())), romanization: None }];
        let song =
            build_song(&lyrics, &hung, &LyricsOptions::default(), &CommentSettings::default(), Decorations::default());
        assert_eq!(song.lines[0].translation, Some(("hello".into(), "en".into())));
        // A translation that only repeats the line is not shown.
        let hung = vec![Hung { translation: Some(("Hola!".into(), "en".into())), romanization: None }];
        let song =
            build_song(&lyrics, &hung, &LyricsOptions::default(), &CommentSettings::default(), Decorations::default());
        assert_eq!(song.lines[0].translation, None);
    }
}
