/**
 * Pure helpers for mapping a note to its file in the GitHub repo and naming
 * the local copy of the original.
 */

/**
 * The repo path for a note: the frontmatter `git:` value is a folder (e.g.
 * `Classes/2026-B/RD - POGO 801/Assign/Final/`) that the note's file name is
 * appended to, or a full path when it already ends in `.md`. Null when blank.
 */
export function repoFilePath(gitField: string, fileName: string): string | null {
	let p = gitField
		.trim()
		.replace(/^["']|["']$/g, '')
		.replace(/\\/g, '/');
	p = p.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
	if (!p && !fileName) return null;
	if (/\.md$/i.test(p)) return p;
	return p ? `${p}/${fileName}` : fileName;
}

/** `owner/name`, tolerating a full github.com URL. Null when malformed. */
export function parseRepo(s: string): { owner: string; name: string } | null {
	const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s.trim());
	return m ? { owner: m[1], name: m[2] } : null;
}

/** GitHub Contents API URL for a repo path (each segment percent-encoded). */
export function contentsUrl(repo: string, path: string, ref?: string): string {
	const r = parseRepo(repo);
	if (!r) throw new Error(`"${repo}" is not a GitHub repository (expected owner/name).`);
	const enc = path.split('/').map(encodeURIComponent).join('/');
	const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	return `https://api.github.com/repos/${r.owner}/${r.name}/contents/${enc}${q}`;
}

function pad(n: number): string {
	return n.toString().padStart(2, '0');
}

/** `YYYYMMDD-HHMMSS` in local time, for the `pushed:` field. */
export function pushedStamp(d: Date): string {
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
		`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

/** `Folder/Final.md` + `.original.md` → `Folder/Final.original.md`. */
export function sidecarPath(notePath: string, suffix: string): string {
	return notePath.replace(/\.md$/i, '') + suffix;
}

export function isSidecar(path: string, suffix: string): boolean {
	return suffix !== '' && path.toLowerCase().endsWith(suffix.toLowerCase());
}
