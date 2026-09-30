export function prettyTtml(src: string): string {
	return src
		.replace(/(<(?:head|body|\/head|\/body|\/tt)[\s>])/g, "\n$1")
		.replace(/(<(?:div|\/div)[\s>])/g, "\n  $1")
		.replace(/(<(?:p|ttm:agent|iTunesMetadata)[\s>/])/g, "\n    $1")
		.trimStart();
}
