import { type CompileError, compileWithDetails } from "rics";

export type { CompileError };

export interface CompileOptions {
	timeout?: number;
	maxIterations?: number;
	hardTimeout?: number;
}

export interface CompileResult {
	css: string;
	errors: CompileError[];
	timedOut: boolean;
}

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_MAX_ITERATIONS = 10000;
const DEFAULT_HARD_TIMEOUT = 5000;

export function compileRics(sourceCode: string, options: CompileOptions = {}): CompileResult {
	const {
		timeout = DEFAULT_TIMEOUT,
		maxIterations = DEFAULT_MAX_ITERATIONS,
		hardTimeout = DEFAULT_HARD_TIMEOUT,
	} = options;

	try {
		const startTime = performance.now();
		const result = compileWithDetails(sourceCode, { timeout, maxIterations });
		const elapsed = performance.now() - startTime;

		if (elapsed > hardTimeout) {
			return {
				css: sourceCode,
				errors: [
					{
						type: "error",
						code: 0 as any,
						message: `Compilation timeout: took ${elapsed.toFixed(0)}ms (limit: ${hardTimeout}ms)`,
					},
				],
				timedOut: true,
			};
		}

		if (result.errors.length > 0) {
			return {
				css: sourceCode,
				errors: result.errors,
				timedOut: false,
			};
		}

		return {
			css: result.css,
			errors: [],
			timedOut: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			css: sourceCode,
			errors: [{ type: "error", code: 0 as any, message }],
			timedOut: false,
		};
	}
}

export function compileRicsToCSS(sourceCode: string, options: CompileOptions = {}): string {
	return compileRics(sourceCode, options).css;
}
