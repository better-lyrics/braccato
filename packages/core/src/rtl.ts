const RTL_REGEX = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;
const NON_LATIN_REGEX = /[^\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]/u;

export function testRtl(text: string): boolean {
	return RTL_REGEX.test(text);
}

export function containsNonLatin(text: string): boolean {
	return NON_LATIN_REGEX.test(text);
}
