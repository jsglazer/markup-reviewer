import Anthropic from '@anthropic-ai/sdk';
import { requestUrl } from 'obsidian';
import { makeRequestFetch } from './core/fetch-adapter';
import { READ_SCHEMA, parseReadResult } from './core/schema';
import { COMMIT_SYSTEM, SYSTEM_PROMPT, commitPrompt, userPrompt } from './core/prompt';
import type { ReadResult } from './core/types';
import type { Effort } from './settings';

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
	'claude-opus-5-5',
	'claude-opus-5',
	'claude-fable-5-1',
	'claude-sonnet-5-5',
]);

/** The API caps a request at 32 MB; base64 adds a third. */
export const MAX_PDF_BYTES = 23 * 1024 * 1024;

export interface ReadOptions {
	apiKey: string;
	model: string;
	effort: Effort;
	pdfBase64: string;
	noteName: string;
	markdown: string;
	signal?: AbortSignal;
}

export interface ReadOutcome extends ReadResult {
	usage: string;
}

function describeUsage(u: Anthropic.Beta.BetaUsage): string {
	const cached = u.cache_read_input_tokens ?? 0;
	return `${u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0)} in · ${u.output_tokens} out`;
}

function friendlyError(e: unknown): Error {
	if (e instanceof Anthropic.APIUserAbortError) return new Error('Cancelled.');
	if (e instanceof Anthropic.AuthenticationError)
		return new Error('The API key was rejected. Check the secret in settings.');
	if (e instanceof Anthropic.PermissionDeniedError)
		return new Error('This API key cannot use the selected model.');
	if (e instanceof Anthropic.NotFoundError)
		return new Error('Model not found. Check the model in settings.');
	if (e instanceof Anthropic.RateLimitError)
		return new Error('Rate limited by the API. Try again in a minute.');
	if (e instanceof Anthropic.BadRequestError)
		return new Error(`The API rejected the request: ${e.message}`);
	if (e instanceof Anthropic.APIError)
		return new Error(`API error ${String(e.status ?? '')}: ${e.message}`);
	return e instanceof Error ? e : new Error(String(e));
}

/** Read the pen markup on a scanned PDF against the note's markdown. */
export async function readMarkup(opts: ReadOptions): Promise<ReadOutcome> {
	const client = new Anthropic({
		apiKey: opts.apiKey,
		dangerouslyAllowBrowser: true,
		fetch: makeRequestFetch(requestUrl),
	});
	const useFallback = FALLBACK_MODELS.has(opts.model);
	try {
		const message = await client.beta.messages
			.stream(
				{
					model: opts.model,
					max_tokens: 32000,
					thinking: { type: 'adaptive' },
					output_config: {
						effort: opts.effort,
						format: { type: 'json_schema', schema: READ_SCHEMA },
					},
					system: [{ type: 'text', text: SYSTEM_PROMPT }],
					messages: [
						{
							role: 'user',
							content: [
								{
									type: 'document',
									source: {
										type: 'base64',
										media_type: 'application/pdf',
										data: opts.pdfBase64,
									},
								},
								{ type: 'text', text: userPrompt(opts.noteName, opts.markdown) },
							],
						},
					],
					...(useFallback
						? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
						: {}),
				},
				{ signal: opts.signal },
			)
			.finalMessage();

		if (message.stop_reason === 'refusal') {
			const category = message.stop_details?.category ?? 'unspecified';
			throw new Error(`Claude declined this request (category: ${category}).`);
		}
		if (message.stop_reason === 'max_tokens') {
			throw new Error(
				'The response was cut off (output limit reached). Try a lower effort or fewer pages.',
			);
		}
		const text = message.content
			.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
			.map((b) => b.text)
			.join('');
		return { ...parseReadResult(text), usage: describeUsage(message.usage) };
	} catch (e) {
		throw friendlyError(e);
	}
}

export interface CommitOptions {
	apiKey: string;
	model: string;
	noteName: string;
	/** e.g. "+12 words, −3 words, 1 move". */
	stats: string;
	/** The changed passages in CriticMarkup, one per paragraph, with line numbers. */
	changes: string;
	signal?: AbortSignal;
}

/** Draft a commit message for the tracked edits. A short task, so low effort. */
export async function draftCommitMessage(opts: CommitOptions): Promise<string> {
	const client = new Anthropic({
		apiKey: opts.apiKey,
		dangerouslyAllowBrowser: true,
		fetch: makeRequestFetch(requestUrl),
	});
	const useFallback = FALLBACK_MODELS.has(opts.model);
	try {
		const message = await client.beta.messages.create(
			{
				model: opts.model,
				max_tokens: 16000,
				output_config: { effort: 'low' },
				system: [{ type: 'text', text: COMMIT_SYSTEM }],
				messages: [
					{ role: 'user', content: commitPrompt(opts.noteName, opts.stats, opts.changes) },
				],
				...(useFallback
					? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
					: {}),
			},
			{ signal: opts.signal },
		);
		if (message.stop_reason === 'refusal') {
			const category = message.stop_details?.category ?? 'unspecified';
			throw new Error(`Claude declined this request (category: ${category}).`);
		}
		const text = message.content
			.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
			.map((b) => b.text)
			.join('')
			.trim();
		if (!text) throw new Error('Claude returned an empty message.');
		return text;
	} catch (e) {
		throw friendlyError(e);
	}
}
