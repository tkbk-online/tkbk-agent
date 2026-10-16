import { createHash } from "node:crypto"

export interface CodeChunk {
	/** stable id: sha1 of path + start line + content */
	id: string
	/** workspace-relative path with forward slashes */
	path: string
	/** 1-based inclusive line range */
	startLine: number
	endLine: number
	text: string
}

export interface ChunkOptions {
	/** target chunk size in lines */
	maxLines?: number
	/** lines carried over from the previous chunk for context */
	overlapLines?: number
}

const DEFAULT_MAX_LINES = 60
const DEFAULT_OVERLAP = 6

/**
 * Lines that usually start a top-level unit in most languages: functions,
 * classes, exported declarations, Python/Go/Rust/Java definitions, Markdown
 * headings. A chunk prefers to break right before such a line so a symbol and
 * its body stay together.
 */
const BOUNDARY =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|func|pub(?:\(crate\))?\s+fn|impl|struct|trait|module|namespace|public|private|protected|static|#{1,6}\s)\b/

export function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex")
}

/**
 * Split a file into overlapping line-range chunks, breaking at symbol
 * boundaries when one is near the target size. Language-agnostic by design:
 * it works the same on TypeScript, Python, Go, SQL and Markdown and needs no
 * parser binaries in the extension bundle.
 */
export function chunkFile(path: string, content: string, options: ChunkOptions = {}): CodeChunk[] {
	const maxLines = Math.max(10, options.maxLines ?? DEFAULT_MAX_LINES)
	const overlap = Math.min(Math.max(0, options.overlapLines ?? DEFAULT_OVERLAP), Math.floor(maxLines / 3))
	const lines = content.split(/\r?\n/)
	if (lines.length === 0 || content.trim().length === 0) {
		return []
	}

	const chunks: CodeChunk[] = []
	let start = 0
	while (start < lines.length) {
		let end = Math.min(lines.length, start + maxLines)
		if (end < lines.length) {
			// Look back up to a third of the chunk for a symbol boundary.
			const floor = start + Math.floor(maxLines * 0.66)
			for (let i = end; i > floor; i--) {
				if (BOUNDARY.test(lines[i].trimStart()) && lines[i].search(/\S/) === 0) {
					end = i
					break
				}
			}
		}
		const slice = lines.slice(start, end)
		const text = slice.join("\n")
		if (text.trim().length > 0) {
			chunks.push({
				id: sha1(`${path}:${start + 1}:${text}`).slice(0, 20),
				path,
				startLine: start + 1,
				endLine: end,
				text,
			})
		}
		if (end >= lines.length) {
			break
		}
		start = Math.max(end - overlap, start + 1)
	}
	return chunks
}

/**
 * Identifier-aware tokens for lexical search: splits camelCase and
 * snake_case, lowercases, drops one-character noise. `getUserById` becomes
 * `getuserbyid get user by id`, so both the whole name and its parts match.
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = []
	const words = text.match(/[A-Za-z_][A-Za-z0-9_]*|[\p{L}]+|\d+/gu) ?? []
	for (const word of words) {
		const lower = word.toLowerCase()
		if (lower.length > 1) {
			tokens.push(lower)
		}
		const parts = word
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.split(/[_\s]+/)
			.map((p) => p.toLowerCase())
			.filter((p) => p.length > 1 && p !== lower)
		tokens.push(...parts)
	}
	return tokens
}
