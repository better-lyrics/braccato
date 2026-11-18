//! The lyric shapes handed in from JavaScript, matching `@braccato/types`.

use serde::{Deserialize, Deserializer};
use std::collections::BTreeMap;

/// JavaScript hands over `undefined` and `null` for fields it means to leave out. Both read as the
/// field's default rather than as an error.
fn lenient<'de, D: Deserializer<'de>, T: Deserialize<'de> + Default>(deserializer: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricPart {
    #[serde(default, deserialize_with = "lenient")]
    pub start_time_ms: f64,
    #[serde(default, deserialize_with = "lenient")]
    pub words: String,
    #[serde(default, deserialize_with = "lenient")]
    pub duration_ms: f64,
    #[serde(default, deserialize_with = "lenient")]
    pub is_background: bool,
    #[serde(default)]
    pub background_group: Option<u32>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct OldTranslation {
    pub text: String,
    #[serde(default, deserialize_with = "lenient")]
    pub lang: String,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lyric {
    #[serde(default, deserialize_with = "lenient")]
    pub start_time_ms: f64,
    #[serde(default, deserialize_with = "lenient")]
    pub words: String,
    #[serde(default, deserialize_with = "lenient")]
    pub duration_ms: f64,
    #[serde(default)]
    pub parts: Option<Vec<LyricPart>>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub translations: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub translation: Option<OldTranslation>,
    #[serde(default)]
    pub romanization: Option<String>,
    #[serde(default)]
    pub timed_romanization: Option<Vec<LyricPart>>,
    #[serde(default, deserialize_with = "lenient")]
    pub is_instrumental: bool,
}

/// How a song is timed, which decides how its lines light up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncType {
    /// Every word or syllable carries its own time.
    Richsync,
    /// Lines carry times, words do not.
    Synced,
    /// Nothing is timed.
    None,
}

impl SyncType {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncType::Richsync => "richsync",
            SyncType::Synced => "synced",
            SyncType::None => "none",
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricsOptions {
    #[serde(default, deserialize_with = "lenient")]
    pub no_lyrics: bool,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub songwriters: Option<Vec<String>>,
    /// Which song these lyrics are for. Lyrics with the key of the song on screen are swapped into
    /// it rather than built anew.
    #[serde(default)]
    pub song_key: Option<String>,
}

/// Picks the sync type the way the DOM renderer did: richsync when any sung line has a part with a
/// duration, none when every line starts at zero, synced otherwise.
pub fn detect_sync_type(lyrics: &[Lyric], richsync_disabled: bool) -> SyncType {
    let rich = !richsync_disabled
        && lyrics.iter().any(|line| {
            !line.is_instrumental
                && line.parts.as_ref().is_some_and(|parts| parts.iter().any(|part| part.duration_ms != 0.0))
        });
    if rich {
        SyncType::Richsync
    } else if lyrics.iter().all(|line| line.start_time_ms == 0.0) {
        SyncType::None
    } else {
        SyncType::Synced
    }
}
