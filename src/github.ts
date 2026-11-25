/**
 * Read and write one file in a GitHub repo through the Contents API. Uses
 * Obsidian's requestUrl (no CORS limits, works on mobile) and a fine-grained
 * personal access token kept in Obsidian's keychain.
 */
import { arrayBufferToBase64, base64ToArrayBuffer, requestUrl } from 'obsidian';
import { contentsUrl, parseRepo } from './core/repo';

export interface GitHubConfig {
	token: string;
	/** `owner/name`. */
	repo: string;
	branch: string;
}

export interface RemoteFile {
	/** Blob SHA, needed to update the file and to detect pushes made elsewhere. */
	sha: string;
	text: string;
}

export interface PutResult {
	/** New blob SHA of the file. */
	sha: string;
	/** SHA of the commit the push made, or null if GitHub didn't return it. */
	commit: string | null;
}

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const API_VERSION = '2022-11-28';

function headers(
	cfg: GitHubConfig,
	accept = 'application/vnd.github+json',
): Record<string, string> {
	return {
		Accept: accept,
		Authorization: `Bearer ${cfg.token}`,
		'X-GitHub-Api-Version': API_VERSION,
	};
}

function githubMessage(json: unknown): string {
	const m = (json as { message?: unknown } | null)?.message;
	return typeof m === 'string' ? m : '';
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function fail(cfg: GitHubConfig, status: number, body: string, what: string): GitHubError {
	const msg = githubMessage(safeJson(body));
	const detail = msg ? ` GitHub said: “${msg}”.` : '';
	switch (status) {
		case 401:
			return new GitHubError(
				`GitHub rejected the token (401). Check the GitHub token secret in Markup Reviewer settings.${detail}`,
				status,
			);
		case 403:
			return new GitHubError(
				`GitHub refused to ${what} (403). The token needs Contents read and write access to ${cfg.repo}, or the rate limit was hit.${detail}`,
				status,
			);
		case 404:
			return new GitHubError(
				`GitHub couldn't find ${cfg.repo} (404). Check the repository and branch in settings, and that the token can access it.${detail}`,
				status,
			);
		case 409:
		case 422:
			return new GitHubError(
				`GitHub refused to ${what} (${status}): the file changed on GitHub since it was read, or the branch "${cfg.branch}" doesn't exist.${detail}`,
				status,
			);
		default:
			return new GitHubError(`GitHub error ${status} while trying to ${what}.${detail}`, status);
	}
}

function encodeUtf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return arrayBufferToBase64(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	);
}

function decodeUtf8(b64: string): string {
	return new TextDecoder().decode(base64ToArrayBuffer(b64.replace(/\s+/g, '')));
}

async function repoExists(cfg: GitHubConfig): Promise<boolean> {
	const r = parseRepo(cfg.repo);
	if (!r) return false;
	const res = await requestUrl({
		url: `https://api.github.com/repos/${r.owner}/${r.name}`,
		headers: headers(cfg),
		throw: false,
	});
	return res.status === 200;
}

/** The file at `path`, or null when the repo is reachable but the file isn't there. */
export async function getFile(cfg: GitHubConfig, path: string): Promise<RemoteFile | null> {
	const url = contentsUrl(cfg.repo, path, cfg.branch);
	const res = await requestUrl({ url, headers: headers(cfg), throw: false });
	if (res.status === 404) {
		if (await repoExists(cfg)) return null;
		throw fail(cfg, 404, res.text, 'read the file');
	}
	if (res.status !== 200) throw fail(cfg, res.status, res.text, 'read the file');

	const json = safeJson(res.text) as
		| { type?: string; sha?: string; content?: string; encoding?: string; size?: number }
		| unknown[]
		| null;
	if (!json || Array.isArray(json) || json.type !== 'file' || !json.sha) {
		throw new GitHubError(`"${path}" on GitHub is a folder or not a regular file.`, 200);
	}
	if (json.encoding === 'base64' && (json.content || json.size === 0)) {
		return { sha: json.sha, text: decodeUtf8(json.content ?? '') };
	}
	// Files over 1 MB come back without inline content: fetch the raw bytes.
	const raw = await requestUrl({
		url,
		headers: headers(cfg, 'application/vnd.github.raw+json'),
		throw: false,
	});
	if (raw.status !== 200) throw fail(cfg, raw.status, raw.text, 'read the file');
	return { sha: json.sha, text: raw.text };
}

/**
 * Create or update the file. `sha` is the blob being replaced (null to create);
 * GitHub rejects the write if the file has changed since. Returns the new SHA.
 */
export async function putFile(
	cfg: GitHubConfig,
	path: string,
	text: string,
	message: string,
	sha: string | null,
): Promise<PutResult> {
	const body: Record<string, string> = { message, content: encodeUtf8(text), branch: cfg.branch };
	if (sha) body.sha = sha;
	const res = await requestUrl({
		url: contentsUrl(cfg.repo, path),
		method: 'PUT',
		headers: headers(cfg),
		contentType: 'application/json',
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status !== 200 && res.status !== 201)
		throw fail(cfg, res.status, res.text, 'save the file');
	const json = safeJson(res.text) as {
		content?: { sha?: string };
		commit?: { sha?: string };
	} | null;
	const newSha = json?.content?.sha;
	if (!newSha)
		throw new GitHubError('GitHub accepted the push but returned no file SHA.', res.status);
	return { sha: newSha, commit: json?.commit?.sha ?? null };
}

function gitApi(cfg: GitHubConfig, path: string): string {
	const r = parseRepo(cfg.repo);
	if (!r) throw new Error(`"${cfg.repo}" is not a GitHub repository (expected owner/name).`);
	return `https://api.github.com/repos/${r.owner}/${r.name}/git/${path}`;
}

/**
 * Create an annotated tag `name` on `commit` and push its ref. When a tag of
 * that name already exists, `-2`, `-3`, … is appended (up to `-9`), so a
 * resubmission with the same stamp still gets its own tag. Returns the name used.
 */
export async function createTag(
	cfg: GitHubConfig,
	name: string,
	commit: string,
	message: string,
): Promise<string> {
	for (let n = 1; n <= 9; n++) {
		const tag = n === 1 ? name : `${name}-${n}`;
		const obj = await requestUrl({
			url: gitApi(cfg, 'tags'),
			method: 'POST',
			headers: headers(cfg),
			contentType: 'application/json',
			body: JSON.stringify({ tag, message, object: commit, type: 'commit' }),
			throw: false,
		});
		if (obj.status !== 201) throw fail(cfg, obj.status, obj.text, 'create the tag');
		const tagSha = (safeJson(obj.text) as { sha?: string } | null)?.sha;
		if (!tagSha) throw new GitHubError('GitHub created the tag but returned no SHA.', obj.status);
		const ref = await requestUrl({
			url: gitApi(cfg, 'refs'),
			method: 'POST',
			headers: headers(cfg),
			contentType: 'application/json',
			body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: tagSha }),
			throw: false,
		});
		if (ref.status === 201) return tag;
		const exists = ref.status === 422 && /already exists/i.test(githubMessage(safeJson(ref.text)));
		if (!exists) throw fail(cfg, ref.status, ref.text, 'create the tag');
	}
	throw new GitHubError(`Tags ${name} through ${name}-9 already exist on GitHub.`, 422);
}
