export function prettyTtml(src: string): string {
	return src
		.replace(/\s*(<(?:head|body|\/head|\/body|\/tt)[\s>])/g, "\n$1")
		.replace(/\s*(<(?:div|\/div)[\s>])/g, "\n  $1")
		.replace(/\s*(<(?:p|ttm:agent|iTunesMetadata)[\s>/])/g, "\n    $1")
		.trimStart();
}
