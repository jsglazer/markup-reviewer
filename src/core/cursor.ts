/** What the status-bar cursor readout shows. */
export type CursorDisplay = 'off' | 'line' | 'line-col';

/** Status-bar text for a 0-based editor position, e.g. "Ln 42" or "Ln 42, Col 7". */
export function formatCursor(line: number, ch: number, display: CursorDisplay): string {
	if (display === 'off') return '';
	const ln = `Ln ${line + 1}`;
	return display === 'line-col' ? `${ln}, Col ${ch + 1}` : ln;
}
