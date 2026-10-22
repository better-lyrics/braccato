---
"@braccato/core": patch
---

A host that drives the clock without player snapshots, such as an audio element looping a range shorter than half a second, no longer leaves upcoming lines sweeping from the clock before each pass.
