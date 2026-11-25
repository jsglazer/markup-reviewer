import { describe, expect, it } from 'vitest';
import { formatCursor } from '../src/core/cursor';

describe('formatCursor', () => {
	it('shows the 1-based line', () => {
		expect(formatCursor(0, 0, 'line')).toBe('Ln 1');
		expect(formatCursor(41, 6, 'line')).toBe('Ln 42');
	});
	it('adds the 1-based column when asked', () => {
		expect(formatCursor(41, 6, 'line-col')).toBe('Ln 42, Col 7');
	});
	it('is empty when off', () => {
		expect(formatCursor(41, 6, 'off')).toBe('');
	});
});
