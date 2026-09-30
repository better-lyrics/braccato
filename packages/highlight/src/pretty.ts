// The lookbehind anchors each whitespace run at its first character, which keeps the scan linear.
export function prettyTtml(src: string): string {
	return src
		.replace(/(?:(?<!\s)\s+)?(<(?:head|body|\/head|\/body|\/tt)[\s>])/g, "\n$1")
		.replace(/(?:(?<!\s)\s+)?(<(?:div|\/div)[\s>])/g, "\n  $1")
		.replace(/(?:(?<!\s)\s+)?(<(?:p|ttm:agent|iTunesMetadata)[\s>/])/g, "\n    $1")
		.trimStart();
}
