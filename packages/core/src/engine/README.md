# The engine

One engine instance (`instance.ts`) per rendered view holds that view's lines, its selection, its scroll
state and the per-frame work that keeps them in step. `renderer.ts` is what a consumer holds; the instance
is what it is holding.

Instances rather than a singleton, because a consumer can render more than one view at once. Better Lyrics,
for example, runs a YouTube Music side panel and a floating window. Views share parsed lyric data and the
playback clock and nothing else, so anything one view can disagree with another about lives on its instance.

The host supplies ticks; the engine schedules no tick loop of its own. Each tick arrives with the time
already on it (in Better Lyrics, an interpolated player snapshot), and `clock.ts` keeps only the history of
those ticks. The one frame loop the engine runs is the passive scroll for unsynced lyrics.

Some state is module scope rather than instance scope: the set of live instances (`liveViews.ts`), the
playback clock (`clock.ts`), and the theme settings (`../themeSettings.ts`). Their unit is a bundle rather
than a document, so a consumer that bundles the engine into two script worlds, as Better Lyrics does for its
isolated and page worlds, gets two independent copies of each.
