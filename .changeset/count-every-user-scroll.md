---
"@braccato/core": minor
---

A host that ticks every frame can set the new `countEveryUserScroll` tick option so a reader's scroll pauses autoscroll of synced lyrics. By default the view still holds one scroll back for the one a refocused window fires, which a host ticking every frame spends on each scroll the reader makes. It defaults to false, so existing hosts behave as before. Synced autoscroll also stops holding back a scroll for a write that left the position where it was, since no scroll event follows one.
