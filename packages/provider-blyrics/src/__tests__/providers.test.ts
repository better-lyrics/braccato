import { afterEach, describe, expect, it, vi } from "vitest";
import { createBinimumProvider } from "../providers/binimum.js";
import { createBLyricsProvider } from "../providers/blyrics.js";
import { createLegatoProvider } from "../providers/legato.js";
import { createLRCLibPlainProvider, createLRCLibSyncedProvider } from "../providers/lrclib.js";
import { createPortatoProvider } from "../providers/portato.js";
import { createUnisonProvider } from "../providers/unison.js";
import type { ProviderContext } from "../types.js";

const TTML = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
	<body dur="30s">
		<div>
			<p begin="5s" end="10s" key="l1">
				<span begin="5s" end="7s"><span>Hello </span></span>
				<span begin="7s" end="10s"><span>world</span></span>
			</p>
		</div>
	</body>
</tt>`;

const QRC = `[1000,2000]First(1000,1000) line(2000,1000)
[4000,2000]Second(4000,1000) line(5000,1000)`;

const LRC = `[00:12.50]Hello world
[00:15.00]Second line`;

const PLAIN = "Hello world\nSecond line";

function makeCtx(overrides: Partial<ProviderContext> = {}): ProviderContext {
	return {
		song: "Paradise",
		artist: "Coldplay",
		album: "Mylo Xyloto",
		duration: 279,
		signal: new AbortController().signal,
		...overrides,
	};
}

type Route = (url: string) => { ok: boolean; status?: number; json?: unknown; text?: string };

function stubFetch(route: Route) {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL) => {
		const url = input.toString();
		calls.push(url);
		const r = route(url);
		return {
			ok: r.ok,
			status: r.status ?? (r.ok ? 200 : 500),
			json: async () => r.json,
			text: async () => r.text ?? "",
		} as Response;
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createPortatoProvider", () => {
	it("parses QRC into word-synced lyrics with attribution", async () => {
		stubFetch(() => ({ ok: true, json: { lyrics: QRC } }));

		const result = await createPortatoProvider()(makeCtx());

		expect(result).not.toBeNull();
		expect(result!.lyrics!.some((l) => !l.isInstrumental)).toBe(true);
		expect(result!.source).toBe("Better Lyrics Portato");
		expect(result!.sourceHref).toBe("https://boidu.dev/");
		expect(result!.musicVideoSynced).toBe(false);
		expect(result!.cacheAllowed).toBe(true);
	});

	it("sends song, artist, duration, and album as s/a/d/al", async () => {
		const calls = stubFetch(() => ({ ok: true, json: { lyrics: QRC } }));

		await createPortatoProvider()(makeCtx());

		const url = new URL(calls[0]);
		expect(url.searchParams.get("s")).toBe("Paradise");
		expect(url.searchParams.get("a")).toBe("Coldplay");
		expect(url.searchParams.get("d")).toBe("279");
		expect(url.searchParams.get("al")).toBe("Mylo Xyloto");
	});

	it("returns null when the response carries an error", async () => {
		stubFetch(() => ({ ok: true, json: { error: "not found" } }));
		expect(await createPortatoProvider()(makeCtx())).toBeNull();
	});

	it("returns null on a non-ok response", async () => {
		stubFetch(() => ({ ok: false, status: 500 }));
		expect(await createPortatoProvider()(makeCtx())).toBeNull();
	});
});

describe("createBinimumProvider", () => {
	it("searches, then fetches the first result's TTML", async () => {
		const calls = stubFetch((url) =>
			url.includes(".ttml")
				? { ok: true, text: TTML }
				: {
						ok: true,
						json: {
							total: 1,
							results: [{ timing_type: "word", lyricsUrl: "https://lyrics-storage.binimum.org/X.ttml" }],
						},
					},
		);

		const result = await createBinimumProvider()(makeCtx());

		expect(result).not.toBeNull();
		expect(result!.lyrics!.length).toBeGreaterThan(0);
		expect(result!.source).toBe("BiniLyrics");
		expect(result!.sourceHref).toBe("https://lyrics-api.binimum.org/");
		expect(calls[1]).toBe("https://lyrics-storage.binimum.org/X.ttml");
	});

	it("searches by track, artist, duration, and album", async () => {
		const calls = stubFetch((url) =>
			url.includes(".ttml")
				? { ok: true, text: TTML }
				: { ok: true, json: { results: [{ lyricsUrl: "https://lyrics-storage.binimum.org/X.ttml" }] } },
		);

		await createBinimumProvider()(makeCtx());

		const url = new URL(calls[0]);
		expect(url.searchParams.get("track")).toBe("Paradise");
		expect(url.searchParams.get("artist")).toBe("Coldplay");
		expect(url.searchParams.get("duration")).toBe("279");
		expect(url.searchParams.get("album")).toBe("Mylo Xyloto");
	});

	it("returns null when the search has no results", async () => {
		stubFetch(() => ({ ok: true, json: { total: 0, results: [] } }));
		expect(await createBinimumProvider()(makeCtx())).toBeNull();
	});

	it("returns null when the first result has no lyricsUrl", async () => {
		stubFetch(() => ({ ok: true, json: { results: [{ timing_type: "line" }] } }));
		expect(await createBinimumProvider()(makeCtx())).toBeNull();
	});

	it("returns null when the TTML fetch fails", async () => {
		stubFetch((url) =>
			url.includes(".ttml")
				? { ok: false, status: 404 }
				: { ok: true, json: { results: [{ lyricsUrl: "https://lyrics-storage.binimum.org/X.ttml" }] } },
		);
		expect(await createBinimumProvider()(makeCtx())).toBeNull();
	});
});

describe("createUnisonProvider", () => {
	it("parses TTML when format is ttml", async () => {
		stubFetch(() => ({ ok: true, json: { data: { format: "ttml", syncType: "richsync", lyrics: TTML } } }));

		const result = await createUnisonProvider()(makeCtx({ videoId: "abc123" }));

		expect(result).not.toBeNull();
		expect(result!.lyrics!.length).toBeGreaterThan(0);
		expect(result!.source).toBe("Unison");
		expect(result!.cacheAllowed).toBe(false);
	});

	it("parses LRC when format is lrc", async () => {
		stubFetch(() => ({ ok: true, json: { data: { format: "lrc", lyrics: LRC } } }));

		const result = await createUnisonProvider()(makeCtx({ videoId: "abc123" }));

		expect(result!.lyrics!.map((l) => l.words)).toContain("Hello world");
	});

	it("parses plain text when format is plain", async () => {
		stubFetch(() => ({ ok: true, json: { data: { format: "plain", lyrics: PLAIN } } }));

		const result = await createUnisonProvider()(makeCtx({ videoId: "abc123" }));

		expect(result!.lyrics!.length).toBe(2);
	});

	it("sends videoId as v alongside song/artist/duration/album", async () => {
		const calls = stubFetch(() => ({ ok: true, json: { data: { format: "lrc", lyrics: LRC } } }));

		await createUnisonProvider()(makeCtx({ videoId: "abc123" }));

		const url = new URL(calls[0]);
		expect(url.searchParams.get("v")).toBe("abc123");
		expect(url.searchParams.get("song")).toBe("Paradise");
		expect(url.searchParams.get("artist")).toBe("Coldplay");
		expect(url.searchParams.get("duration")).toBe("279");
		expect(url.searchParams.get("album")).toBe("Mylo Xyloto");
	});

	it("returns null on 404", async () => {
		stubFetch(() => ({ ok: false, status: 404 }));
		expect(await createUnisonProvider()(makeCtx({ videoId: "abc123" }))).toBeNull();
	});

	it("returns null when data has no format or lyrics", async () => {
		stubFetch(() => ({ ok: true, json: { data: {} } }));
		expect(await createUnisonProvider()(makeCtx({ videoId: "abc123" }))).toBeNull();
	});
});

describe("createBLyricsProvider", () => {
	it("parses TTML and carries the language", async () => {
		stubFetch(() => ({ ok: true, json: { ttml: TTML, lang: "en" } }));

		const result = await createBLyricsProvider()(makeCtx());

		expect(result!.lyrics!.length).toBeGreaterThan(0);
		expect(result!.language).toBe("en");
		expect(result!.source).toBe("boidu.dev");
	});

	it("sends s/a/d/al params", async () => {
		const calls = stubFetch(() => ({ ok: true, json: { ttml: TTML } }));

		await createBLyricsProvider()(makeCtx());

		const url = new URL(calls[0]);
		expect(url.searchParams.get("s")).toBe("Paradise");
		expect(url.searchParams.get("a")).toBe("Coldplay");
		expect(url.searchParams.get("d")).toBe("279");
		expect(url.searchParams.get("al")).toBe("Mylo Xyloto");
	});

	it("returns null when the response has no ttml", async () => {
		stubFetch(() => ({ ok: true, json: {} }));
		expect(await createBLyricsProvider()(makeCtx())).toBeNull();
	});

	it("returns null on a non-ok response", async () => {
		stubFetch(() => ({ ok: false, status: 500 }));
		expect(await createBLyricsProvider()(makeCtx())).toBeNull();
	});
});

describe("createLegatoProvider", () => {
	it("parses LRC into line-synced lyrics", async () => {
		stubFetch(() => ({ ok: true, json: { lyrics: LRC } }));

		const result = await createLegatoProvider()(makeCtx());

		expect(result!.lyrics!.map((l) => l.words)).toContain("Hello world");
		expect(result!.source).toBe("Better Lyrics Legato");
	});

	it("returns null when the response has no lyrics", async () => {
		stubFetch(() => ({ ok: true, json: {} }));
		expect(await createLegatoProvider()(makeCtx())).toBeNull();
	});
});

describe("createLRCLibSyncedProvider", () => {
	it("parses syncedLyrics and sends the Lrclib-Client header", async () => {
		let sentHeader: string | undefined;
		vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
			sentHeader = (init?.headers as Record<string, string>)?.["Lrclib-Client"];
			return { ok: true, status: 200, json: async () => ({ syncedLyrics: LRC }) } as Response;
		});

		const result = await createLRCLibSyncedProvider()(makeCtx());

		expect(result!.lyrics!.map((l) => l.words)).toContain("Hello world");
		expect(result!.source).toBe("LRCLib");
		expect(sentHeader).toBeTruthy();
	});

	it("sends lrclib query params", async () => {
		const calls = stubFetch(() => ({ ok: true, json: { syncedLyrics: LRC } }));

		await createLRCLibSyncedProvider()(makeCtx());

		const url = new URL(calls[0]);
		expect(url.searchParams.get("track_name")).toBe("Paradise");
		expect(url.searchParams.get("artist_name")).toBe("Coldplay");
		expect(url.searchParams.get("album_name")).toBe("Mylo Xyloto");
		expect(url.searchParams.get("duration")).toBe("279");
	});

	it("returns null when there are no synced lyrics", async () => {
		stubFetch(() => ({ ok: true, json: { plainLyrics: PLAIN } }));
		expect(await createLRCLibSyncedProvider()(makeCtx())).toBeNull();
	});
});

describe("createLRCLibPlainProvider", () => {
	it("parses plainLyrics with cacheAllowed false", async () => {
		stubFetch(() => ({ ok: true, json: { plainLyrics: PLAIN } }));

		const result = await createLRCLibPlainProvider()(makeCtx());

		expect(result!.lyrics!.length).toBe(2);
		expect(result!.cacheAllowed).toBe(false);
	});

	it("returns null when there are no plain lyrics", async () => {
		stubFetch(() => ({ ok: true, json: { syncedLyrics: LRC } }));
		expect(await createLRCLibPlainProvider()(makeCtx())).toBeNull();
	});
});
