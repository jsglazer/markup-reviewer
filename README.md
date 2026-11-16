# Markup Reviewer

[![GitHub release](https://img.shields.io/github/v/release/jsglazer/markup-reviewer?logo=github)](https://github.com/jsglazer/markup-reviewer/releases) [![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/jsglazer/markup-reviewer/blob/main/LICENSE) [![Made with Claude](https://img.shields.io/badge/Made_with-Claude-D97756?logo=anthropic)](https://claude.ai)

An Obsidian plugin for revising notes: the print → mark up by hand → scan → revise loop, and tracking the edits you type yourself before pushing them to GitHub. Print a note (for example with [Render Doc](https://github.com/jsglazer/render-doc)), mark it up with a pen, scan the pages to a PDF, and Markup Reviewer has Claude read every pen mark and turn it into an edit you can implement or skip from a side panel, with a GitHub-style diff shown right in the note.

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

## Tracking your own edits

Markup Reviewer can also track edits you make by hand, show them as you type, and push the finished note to GitHub. Pen-scan edits you implement from the panel show up in the same markup.

1. Open the note and run **Markup Reviewer: Start tracking edits in this note** (or click the compare icon in the ribbon).
2. The note's `git:` frontmatter field names its folder in the repository (for example `git: Classes/2026-B/RD - POGO 801/Assign/Final/`); the note's file name is added to it. If the field is blank you're asked for a folder, prefilled with the note's vault folder.
3. The copy on GitHub is the **original**. If the note isn't on GitHub yet you're asked whether to push the current version as the original. The original is also kept next to the note as `Final.original.md` (the suffix is a setting), so it works offline and you can open or fix it by hand.
4. Edit normally. Shortly after each change the note is compared with the original:
   - deletions: red text with a red strikethrough
   - additions: green text
   - moves and pasted copies: purple, with a purple marker (↱ or ⧉) where the text came from; click the marker to jump to where it went
5. Switch the display between **Original**, **Markup** and **Final** from the status bar, the commands, the compare button in the note's header, or the review panel's buttons. The Original view is read-only.
6. When you're done, click **Push** in the status bar (or the upload button in the note's header, or **Done: commit and push to GitHub**). Markup Reviewer checks that the GitHub copy hasn't changed since you started, has Claude draft a commit message, and shows it in a popup you can edit. Nothing is pushed until you click **Approve and push**. Then it stamps `pushed:` (YYYYMMDD-HHMMSS), pushes the note, and ends tracking: the marks clear and the copy of the original goes to the trash. Click **Start** again to keep editing with marks; the version you just pushed becomes the new original.

One note is tracked at a time. The top of the review panel (**Toggle review panel**) locks onto the tracked note until you click **Done** or **Stop**: its name stays at the top (click it to open the note), the buttons act on it whichever note you're in, and if you click into another note the panel warns that edits there aren't tracked. When nothing is tracked the panel follows the active note. While a note is tracked, its tab turns light red with a red title, even if another plugin (such as File and Folder Highlighter) colours that tab. The buttons are **Start | Stop | Done** on the first row, shaded light green while the note is being tracked and light red when it isn't, and **Orig | Mark | Final** on the second, with the current display highlighted.

Your text is always in the note itself and saved by Obsidian as usual; the marks are only drawn on screen and are recalculated from the note and the original, so they survive undo, reloads and edits made elsewhere. Nothing is written into the note except the `git:` and `pushed:` fields. **Stop tracking edits in this note** clears the marks and moves the copy of the original to the trash; the note and GitHub are untouched. Its dialog also offers **Push instead (Done)**, in case you meant to push.

With **Keep a change log** on, each push also appends the commit message and the changes (in [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit)) to a `{note} Changes` note next to the note.

The markup shows in Live Preview and Source mode; Reading view shows the final text.

## Commands

All commands appear in the command palette prefixed with **Markup Reviewer:**, and any of them can be given a hotkey.

**Reviewing a scan**

| Command | What it does |
|---|---|
| Review markup from a scanned PDF | Pick a scan of the open note; Claude reads the pen marks and opens one card per edit in the review panel. Offers to resume if the note already has a saved review. Also the pen icon in the ribbon. |
| Toggle review panel | Close the review panel and collapse its sidebar if it's showing; otherwise open it (with the open note's saved review if it has one) and expand the sidebar. |
| Undo last implement or skip | Step back through the panel's Implement and Skip actions, newest first. |
| Clear diff highlights | Remove the green/red highlights left by implemented edits (display only; the note is unchanged). |

**Tracking your own edits**

| Command | What it does |
|---|---|
| Start tracking edits in this note | Fetch the GitHub copy as the original (pushing the note first if it isn't on GitHub) and start showing your edits. One note at a time: finish the tracked note with Done or Stop first. Also the compare icon in the ribbon when nothing is tracked. |
| Done: commit and push to GitHub | Acts on the tracked note from anywhere. Check the GitHub copy is unchanged, show Claude's draft commit message for you to edit or approve, stamp `pushed:`, push, and end tracking. Also the status bar's Push button, the upload button in the note's header, and the ribbon's compare icon while a note is tracked. |
| Stop tracking edits in this note | Acts on the tracked note from anywhere. Clear the marks, unlock the panel and move the copy of the original to the trash; the note and GitHub are unchanged. The dialog also offers **Push instead (Done)**. |
| Cycle display: original, markup, final | Switch to the next display mode. Also the compare button in the note's header. |
| Show the original | Show the text as it is on GitHub: additions hidden, deletions shown as plain text. The note is read-only in this view. |
| Show the markup | Show your edits: red struck deletions, green additions, purple moves and copies. |
| Show the final text | Show the note as it is, with no marks. |

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
| GitHub token | `github-papers-token` secret | A fine-grained personal access token with Contents read and write access to the repository, stored in Obsidian's keychain. |
| Repository | `jsglazer/papers` | Where tracked notes are pushed. |
| Branch | `main` | |
| Original file suffix | `.original.md` | The local copy of the original sits next to the note under this name. |
| Keep a change log | Off | Append each push's commit message and changes to `{note} Changes`. |

## Limits

- PDFs up to 23 MB (the API's request limit after base64 encoding) and 100 pages. Scan at 200–300 dpi; colour helps Claude tell your ink from the print.
- Handwriting recognition is as good as the model's reading of it: low- and medium-confidence readings are flagged on the card, so check those text boxes before implementing.

## Development

```
npm install
npm run build      # type-check + production bundle → main.js
npm test           # vitest unit tests for the pure core (anchoring, diff, undo, schema, edit tracking)
npm run lint
```

The pure logic lives in `src/core/` (no Obsidian imports), including `track.ts` (original vs current → add/delete/move marks), `frontmatter.ts` and `repo.ts`. `src/tracker.ts` runs edit tracking, `src/github.ts` talks to the GitHub Contents API, and `src/cm-diff.ts` is the only module that touches CodeMirror through Obsidian's undocumented `editor.cm`.

## License

MIT
