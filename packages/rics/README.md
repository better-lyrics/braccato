# @braccato/rics

RICS CSS preprocessor. Compile RICS source code to standard CSS.

## Install

```bash
npm i @braccato/rics
```

## Usage

```typescript
import { compileRics, compileRicsToCSS } from "@braccato/rics";

const result = compileRics(ricsSource, { timeout: 3000 });
// result.css, result.errors, result.timedOut

const css = compileRicsToCSS(ricsSource);
```

See the [full documentation](https://braccato.boidu.dev) for details.
