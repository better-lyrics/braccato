export { ProviderChain } from "./chain.js";
export type {
	LyricSourceResult,
	ProviderConfig,
	ProviderContext,
	ProviderFn,
	ProviderRegistration,
} from "./types.js";
export type { ChainOptions } from "./chain.js";
export { createBLyricsProvider, type BLyricsProviderOptions } from "./providers/blyrics.js";
export {
	createLRCLibSyncedProvider,
	createLRCLibPlainProvider,
	type LRCLibProviderOptions,
} from "./providers/lrclib.js";
export { createLegatoProvider, type LegatoProviderOptions } from "./providers/legato.js";
export { stringSimilarity, createSimilarityValidator } from "./validation.js";
