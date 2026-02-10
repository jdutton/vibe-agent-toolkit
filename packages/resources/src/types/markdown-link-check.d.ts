declare module 'markdown-link-check' {
	interface LinkCheckOptions {
		timeout?: string;
		retryOn429?: boolean;
		retryCount?: number;
		fallbackRetryDelay?: string;
		aliveStatusCodes?: number[];
		ignorePatterns?: Array<{ pattern: RegExp }>;
		httpHeaders?: Array<{
			urls: string[];
			headers: Record<string, string>;
		}>;
	}

	interface LinkCheckResult {
		link: string;
		status: string;
		statusCode: number;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Library returns various error types
		err?: string | Error | any;
	}

	type LinkCheckCallback = (error: Error | null, results: LinkCheckResult[]) => void;

	function markdownLinkCheck(
		markdown: string,
		options: LinkCheckOptions,
		callback: LinkCheckCallback,
	): void;
	function markdownLinkCheck(markdown: string, callback: LinkCheckCallback): void;

	export = markdownLinkCheck;
}
