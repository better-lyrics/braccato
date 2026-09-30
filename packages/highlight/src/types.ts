import type { LyricFormat } from "@braccato/parsers/format";

export type { LyricFormat };

export type TokenType =
	| "text"
	| "bgText"
	| "timestamp"
	| "wordTime"
	| "agent"
	| "meta"
	| "tag"
	| "attr"
	| "value"
	| "punct"
	| "comment";

export interface Token {
	type: TokenType;
	text: string;
}

export const TOKEN_TYPES: readonly TokenType[] = [
	"text",
	"bgText",
	"timestamp",
	"wordTime",
	"agent",
	"meta",
	"tag",
	"attr",
	"value",
	"punct",
	"comment",
];
