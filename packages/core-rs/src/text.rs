//! Small text questions the layout asks: which way a string runs, whether its letters join, and
//! where its grapheme clusters are.

use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Ltr,
    Rtl,
}

/// Strong direction of one character, or `None` for neutrals (digits, punctuation, spaces, marks).
pub fn char_direction(c: char) -> Option<Direction> {
    let code = c as u32;
    let rtl = matches!(code,
        0x0590..=0x08FF      // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic ext.
        | 0xFB1D..=0xFDFF    // Hebrew and Arabic presentation forms A
        | 0xFE70..=0xFEFF    // Arabic presentation forms B
        | 0x10800..=0x10FFF  // historic right-to-left scripts
        | 0x1E800..=0x1EFFF  // Mende Kikakui, Adlam, Arabic mathematical
    );
    if rtl {
        return Some(Direction::Rtl);
    }
    if c.is_alphabetic() {
        Some(Direction::Ltr)
    } else {
        None
    }
}

/// The direction of the first strong character, which is what `dir="auto"` and
/// `unicode-bidi: plaintext` resolve a paragraph to.
pub fn first_strong_direction(text: &str) -> Option<Direction> {
    text.chars().find_map(char_direction)
}

/// Whether the text holds characters of both directions.
pub fn is_mixed_direction(text: &str) -> bool {
    let mut seen_ltr = false;
    let mut seen_rtl = false;
    for direction in text.chars().filter_map(char_direction) {
        match direction {
            Direction::Ltr => seen_ltr = true,
            Direction::Rtl => seen_rtl = true,
        }
        if seen_ltr && seen_rtl {
            return true;
        }
    }
    false
}

/// Scripts whose letters change shape with their neighbours. Splitting one of these words into
/// separately drawn letters would break the joins, so such words are never split.
pub fn has_joining_script(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32,
            0x0600..=0x06FF | 0x0700..=0x074F | 0x0750..=0x077F | 0x0780..=0x07BF | 0x07C0..=0x07FF
            | 0x0840..=0x085F | 0x0860..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF
            // Brahmic scripts form conjuncts across letters, Mongolian joins, and so do these.
            | 0x0900..=0x0DFF | 0x0F00..=0x0FFF | 0x1000..=0x109F | 0x1800..=0x18AF | 0xA8E0..=0xA8FF
            | 0x200D
        )
    })
}

/// Whether the text holds an emoji, which is drawn in its own colours rather than tinted.
pub fn has_color_glyphs(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32,
            0x1F000..=0x1FAFF   // mahjong to pictographs extended-A, flags included
            | 0x2600..=0x27BF   // miscellaneous symbols, dingbats
            | 0xFE0F            // emoji presentation selector
        )
    })
}

/// Byte ranges of the grapheme clusters in `text`.
pub fn grapheme_ranges(text: &str) -> Vec<(usize, usize)> {
    text.grapheme_indices(true).map(|(start, g)| (start, start + g.len())).collect()
}

/// UTF-16 offset of a byte offset, which is what DOM ranges count in.
pub fn utf16_offset(text: &str, byte_offset: usize) -> u32 {
    text[..byte_offset].encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directions() {
        assert_eq!(first_strong_direction("123 שלום abc"), Some(Direction::Rtl));
        assert_eq!(first_strong_direction("(hello)"), Some(Direction::Ltr));
        assert_eq!(first_strong_direction("123 !"), None);
        assert!(is_mixed_direction("abc مرحبا"));
        assert!(!is_mixed_direction("日本語 text"));
    }

    #[test]
    fn graphemes_keep_clusters_together() {
        let text = "e\u{301}👍🏽a";
        assert_eq!(grapheme_ranges(text).len(), 3);
        assert_eq!(utf16_offset("👍a", 4), 2);
    }
}
