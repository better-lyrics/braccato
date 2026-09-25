---
"@braccato/parsers": patch
---

LRC reads songwriters from timed credit lines such as `作词：` or `Written by:`, in plain and enhanced LRC, and keeps credit lines out of the parsed lyrics the way QRC does. Both parsers now recognise Traditional Chinese roles and joined or tagged roles such as `作曲/编曲`, `作詞・作曲` and `Rap作词`, and no longer take a sung line ending in a role noun for a credit.
