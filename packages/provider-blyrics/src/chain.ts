import type { LyricSourceResult, ProviderContext, ProviderRegistration } from "./types.js";

export interface ChainOptions {
	priority?: string[];
	disabled?: Set<string>;
	validate?: (result: LyricSourceResult) => boolean;
	onProviderResult?: (key: string, result: LyricSourceResult | null) => void;
	onProviderError?: (key: string, error: Error) => void;
}

export class ProviderChain {
	private providers = new Map<string, ProviderRegistration>();
	private cache = new Map<string, LyricSourceResult | null>();

	register(registration: ProviderRegistration): void {
		this.providers.set(registration.key, registration);
	}

	unregister(key: string): void {
		this.providers.delete(key);
	}

	getRegistered(): ProviderRegistration[] {
		return Array.from(this.providers.values());
	}

	clearCache(): void {
		this.cache.clear();
	}

	async fetchLyrics(ctx: ProviderContext, options: ChainOptions = {}): Promise<LyricSourceResult | null> {
		const { priority, disabled = new Set(), validate, onProviderResult, onProviderError } = options;

		const order = priority ?? this.defaultPriority();

		for (const key of order) {
			if (ctx.signal.aborted) return null;
			if (disabled.has(key)) continue;

			const provider = this.providers.get(key);
			if (!provider) continue;

			try {
				let result = this.cache.get(key);
				if (result === undefined) {
					result = await provider.fetch(ctx);
					this.cache.set(key, result);
				}

				onProviderResult?.(key, result);

				if (result?.lyrics && result.lyrics.length > 0) {
					if (validate && !validate(result)) continue;
					return result;
				}
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				onProviderError?.(key, error);
				this.cache.set(key, null);
			}
		}

		return null;
	}

	private defaultPriority(): string[] {
		return Array.from(this.providers.values())
			.sort((a, b) => {
				const syncOrder = { syllable: 0, word: 1, line: 2, unsynced: 3 };
				return (syncOrder[a.syncType] ?? 99) - (syncOrder[b.syncType] ?? 99);
			})
			.map((p) => p.key);
	}
}
