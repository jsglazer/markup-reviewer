# Markup Reviewer

An Obsidian plugin for the print → mark up by hand → scan → revise loop. Print a note (for example with [Render Doc](https://github.com/jsglazer/render-doc)), mark it up with a pen, scan the pages to a PDF, and Markup Reviewer has Claude read every pen mark and turn it into an edit you can implement or skip from a side panel, with a GitHub-style diff shown right in the note.

## How it works

1. Open the note you printed.
2. Run **Markup Reviewer: Review markup from a scanned PDF** (or click the pen icon in the ribbon).
3. Pick the scan: any PDF in the vault (the scan folder from settings is listed first, newest first), or **Browse for a PDF outside the vault…** for a file in a scanner or Downloads folder.
4. Claude reads the scan against the note's markdown source (with line numbers, so Render Doc's margin line numbers help it place each mark) and returns one edit per pen mark: replacements, insertions, deletions and comments.
5. Work through the cards in the side panel.

## The review panel

Each card shows the page and line, the kind of edit, the pen colour, Claude's description of the mark, the text it removes, and an **editable text box** pre-filled with the proposed new text.

- **Implement** writes the edit into the note. If you changed the text box, its contents are used instead of Claude's reading. (Ctrl/Cmd+Enter in the text box does the same.)
- **Skip** leaves the note alone. A skipped card can be restored.
- **Resolve** appears on comments ("expand this", "cite?") with an empty text box: it marks the remark handled without writing anything. Type text in the box to turn the comment into a real replacement.
- **Use selection** re-anchors a card on what you've selected in the note (or on the cursor position, for an insertion), for when Claude's text couldn't be found or picked the wrong occurrence.
- **Undo** steps back through Implement and Skip actions, newest first, reverting the text it wrote. It keeps 20 levels by default (5–100 in settings) and finds its text again even if you've edited elsewhere in the note since.
- **Next pending**, **Clear marks** and **End review** are in the toolbar.

Selecting a card scrolls the note to it and previews the change inline: the text being removed is struck through on light red, the text being added sits beside it on light green. Implemented edits stay highlighted (green additions, struck red removals) until you clear marks or end the review; turn this off with **Keep implemented edits highlighted**. The highlights are display-only: nothing extra is written into the note. They show in Live Preview and Source mode.

Edits are narrowed to the words that actually change, so striking "very" and writing "quite" changes one word rather than rewriting the sentence, and deleting a word doesn't leave a double space behind.

Reviews are saved per note, so closing the panel or Obsidian doesn't lose your place: running the command on the same note offers to resume. The undo history lasts for the Obsidian session.

## Settings

| Setting | Default | |
|---|---|---|
| Anthropic API key | `anthropic-api-key` secret | Stored in Obsidian's keychain; only the secret's name is saved in the plugin data. |
| Model | Claude Opus 5.5 | Any Claude model that accepts PDF input. |
| Effort | High | Higher reads messy handwriting better but is slower and costs more. |
| Scan folder | (whole vault) | PDFs here are listed first in the picker. |
| Undo levels | 20 | 5–100. |
| Keep implemented edits highlighted | On | |
| Advance automatically | On | Select the next pending edit after Implement or Skip. |

## Limits

- PDFs up to 23 MB (the API's request limit after base64 encoding) and 100 pages. Scan at 200–300 dpi; colour helps Claude tell your ink from the print.
- Handwriting recognition is as good as the model's reading of it: low- and medium-confidence readings are flagged on the card, so check those text boxes before implementing.

## Development

```
npm install
npm run build      # type-check + production bundle → main.js
npm test           # vitest unit tests for the pure core (anchoring, diff, undo, schema)
npm run lint
```

The pure logic lives in `src/core/` (no Obsidian imports). `src/cm-diff.ts` is the only module that touches CodeMirror through Obsidian's undocumented `editor.cm`.

## License

MIT
