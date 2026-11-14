/**
 * JSON schema for Claude's structured output, plus a defensive parser that
 * coerces whatever comes back into ReadResult.
 */
import type { Confidence, EditKind, Ink, RawEdit, ReadResult } from './types';

export const READ_SCHEMA: Record<string, unknown> = {
	type: 'object',
	additionalProperties: false,
	required: ['edits', 'notes'],
	properties: {
		edits: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: [
					'page',
					'line',
					'kind',
					'original',
					'replacement',
					'before',
					'after',
					'mark',
					'ink',
					'confidence',
				],
				properties: {
					page: { type: 'integer' },
					line: { type: ['integer', 'null'] },
					kind: { type: 'string', enum: ['replace', 'insert', 'delete', 'comment'] },
					original: { type: 'string' },
					replacement: { type: 'string' },
					before: { type: 'string' },
					after: { type: 'string' },
					mark: { type: 'string' },
					ink: { type: 'string', enum: ['blue', 'red', 'black', 'other'] },
					confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				},
			},
		},
		notes: { type: 'string' },
	},
};

const KINDS: EditKind[] = ['replace', 'insert', 'delete', 'comment'];
const INKS: Ink[] = ['blue', 'red', 'black', 'other'];
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
	return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Parse Claude's JSON text into a ReadResult, dropping malformed entries. */
export function parseReadResult(text: string): ReadResult {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		// Tolerate prose around the JSON object.
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start < 0 || end <= start) throw new Error('Claude did not return JSON.');
		data = JSON.parse(text.slice(start, end + 1));
	}
	const obj = (data ?? {}) as { edits?: unknown; notes?: unknown };
	const list = Array.isArray(obj.edits) ? obj.edits : [];
	const edits: RawEdit[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const e = item as Record<string, unknown>;
		let kind = pick(e.kind, KINDS, 'comment');
		const original = str(e.original);
		const replacement = str(e.replacement);
		// Normalise contradictory shapes so the panel can trust `kind`.
		if (kind === 'insert' && original) kind = 'replace';
		if (kind === 'replace' && !original) kind = 'insert';
		if (kind === 'replace' && !replacement) kind = 'delete';
		edits.push({
			page: typeof e.page === 'number' && e.page > 0 ? Math.floor(e.page) : 1,
			line: typeof e.line === 'number' && e.line > 0 ? Math.floor(e.line) : null,
			kind,
			original,
			replacement: kind === 'delete' ? '' : replacement,
			before: str(e.before),
			after: str(e.after),
			mark: str(e.mark),
			ink: pick(e.ink, INKS, 'other'),
			confidence: pick(e.confidence, CONFIDENCES, 'medium'),
		});
	}
	return { edits, notes: str(obj.notes) };
}
