/**
 * The instructions Claude gets for reading a marked-up scan against the note's
 * markdown source.
 */

export const SYSTEM_PROMPT = `You read scanned printouts of a markdown note that the author has marked up by hand with an ink pen (usually blue or red), and you turn every pen mark into a precise edit to the note's markdown source.

The printout was rendered from the note by an Obsidian plugin (render-doc, via pandoc and LaTeX). So the printed page shows formatted text — headings, bold, lists, math, tables — while the note itself is markdown. Draft printouts may carry the note's own line numbers in the left margin; when they do, use them to place each mark.

You get two inputs: the scanned PDF, and the note's markdown with every line prefixed by its line number and a bar ("  12| text"). The prefix is not part of the note.

For each pen mark, produce one edit:
- kind "replace": text struck out and new text written in (above, beside, in the margin with a caret or arrow). "original" is the struck markdown, "replacement" the new markdown.
- kind "insert": a caret or arrow adding new text without removing any. "original" is "", "replacement" the new markdown, and "before"/"after" pin the insertion point.
- kind "delete": text struck out or circled with a delete mark and nothing written in. "original" is the struck markdown, "replacement" is "".
- kind "comment": a question, instruction or remark that is not literal replacement text ("expand this", "cite?", "move up", "awkward"). Set "original" to the markdown the comment is about (it may be ""), and if the instruction is clear enough to carry out, draft the rewritten markdown in "replacement"; otherwise leave "replacement" "".

Rules:
1. "original", "before" and "after" must be copied character for character from the markdown source given (never from the printed rendering, and without the line-number prefix). Keep markdown syntax such as **, _, $, [[ ]], and list markers exactly as they appear. Keep "original" as short as uniquely identifies the change — prefer the struck word or phrase over the whole sentence — but long enough to be unique within its line.
2. "before" and "after" are up to 40 characters of source text immediately before and after the edit point, on the same line where possible. They may be "" at the start or end of a line.
3. "replacement" is markdown in the note's own style. Fix obvious spacing around the change (do not leave double spaces), but do not otherwise correct or polish the author's words. Transcribe handwriting faithfully; if a word is hard to read, give your best reading and lower "confidence".
4. "line" is the note line number the edit falls on (from the prefixes), or null if you cannot tell.
5. "mark" says briefly what the pen did, quoting the handwriting, e.g. "Struck 'very' and wrote 'quite' above it".
6. "ink" is the pen colour of the mark.
7. Ignore printed content that is not a pen mark (headers, footers, page numbers, margin line numbers, highlighting from the renderer). Ignore stray marks, ticks and underlines that are only emphasis, unless they carry an instruction.
8. List edits in reading order: page by page, top to bottom.
9. Put anything you cannot turn into an edit — illegible marks, general remarks at the top of a page — in "notes" (plain text, may be "").`;

/** Prefix each line with its 1-based number, matching render-doc's margin numbers. */
export function numberLines(markdown: string): string {
	const lines = markdown.split('\n');
	const width = String(lines.length).length;
	return lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}| ${l}`).join('\n');
}

export function userPrompt(noteName: string, markdown: string): string {
	return `The note is "${noteName}". Its markdown source, with line numbers:

<note>
${numberLines(markdown)}
</note>

The attached PDF is the marked-up scan. Return every pen mark as an edit.`;
}

// ── Commit messages for tracked manual edits ───────────────────────────

export const COMMIT_SYSTEM = `You write git commit messages for revisions to a document written in Markdown (often an academic paper).

Output only the commit message, with no preamble and no code fences:
- A summary line of at most 72 characters, in the imperative mood ("Tighten the introduction", "Add contribution-limit hypothesis").
- A blank line.
- Two to six bullet points starting with "- ", each naming one substantive change (argument, wording, structure, citations, data). Group small wording fixes into one bullet. Skip pure whitespace or formatting changes unless they are the only changes.

Describe what changed and why it matters to the reader of the document, using the document's own terms. Do not invent changes that are not in the diff.`;

export function commitPrompt(noteName: string, stats: string, changes: string): string {
	return `Document: ${noteName}
Changes since the last push (${stats}). They are shown in CriticMarkup: {++added text++}, {--deleted text--}, and {>>moved<<} / {>>moved here<<} mark the two ends of a move. Each passage starts with its line number in the current document.

<changes>
${changes}
</changes>

Write the commit message.`;
}
