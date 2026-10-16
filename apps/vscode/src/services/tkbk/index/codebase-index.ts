import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { type CodeChunk, chunkFile, sha1 } from "./chunker"
import { dot, type Embedder, EmbeddingUnavailableError } from "./embedder"
import { LexicalIndex, type ScoredChunk } from "./lexical"
import { INDEX_MANIFEST_VERSION, type IndexManifest, IndexStore } from "./store"

const execFileAsync = promisify(execFile)

export interface CodebaseIndexOptions {
	root: string
	storeDir: string
	/** `undefined` → lexical-only index */
	embedder?: Embedder
	/** skip files larger than this (default 200 KB) */
	maxFileBytes?: number
	/** cap on chunks per index build (default 30 000) */
	maxChunks?: number
	log?: (message: string) => void
}

export interface IndexStatus {
	files: number
	chunks: number
	/** embedder id or "lexical" */
	mode: string
	updatedAt?: number
	building: boolean
	lastError?: string
}

export interface SearchHit extends ScoredChunk {
	/** which legs ranked it */
	via: Array<"semantic" | "lexical">
}

const ALWAYS_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".tkbk",
	".cline",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".nuxt",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".idea",
	".vscode-test",
])

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".bmp",
	".svg",
	".pdf",
	".zip",
	".gz",
	".tar",
	".7z",
	".rar",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".webm",
	".wav",
	".ogg",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".class",
	".jar",
	".pyc",
	".wasm",
	".lock",
	".min.js",
	".map",
	".pb",
	".sqlite",
	".db",
])

const DEFAULT_MAX_FILE_BYTES = 200 * 1024
const DEFAULT_MAX_CHUNKS = 30_000

export function repoHash(root: string): string {
	return createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 16)
}

function toPosix(p: string): string {
	return p.split(path.sep).join("/")
}

function looksBinary(filePath: string): boolean {
	const lower = filePath.toLowerCase()
	for (const ext of BINARY_EXTENSIONS) {
		if (lower.endsWith(ext)) {
			return true
		}
	}
	return false
}

/**
 * Files to index: `git ls-files` (tracked + untracked, honouring .gitignore)
 * when the root is a git repository, otherwise a directory walk that skips the
 * usual build and dependency folders.
 */
export async function listIndexableFiles(root: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			maxBuffer: 64 * 1024 * 1024,
		})
		const files = stdout.split("\0").filter((f) => f.length > 0 && !looksBinary(f))
		return files.filter((f) => !f.split("/").some((segment) => ALWAYS_SKIP_DIRS.has(segment)))
	} catch {
		const out: string[] = []
		const walk = async (dir: string): Promise<void> => {
			let entries: Awaited<ReturnType<typeof readdir>>
			try {
				entries = await readdir(dir, { withFileTypes: true })
			} catch {
				return
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (!ALWAYS_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
						await walk(path.join(dir, entry.name))
					}
				} else if (entry.isFile()) {
					const rel = toPosix(path.relative(root, path.join(dir, entry.name)))
					if (!looksBinary(rel)) {
						out.push(rel)
					}
				}
			}
		}
		await walk(root)
		return out
	}
}

/** Reciprocal-rank fusion of the semantic and lexical legs. */
export function fuseRankings(semantic: ScoredChunk[], lexical: ScoredChunk[], limit: number): SearchHit[] {
	const k = 60
	const merged = new Map<string, SearchHit>()
	const add = (list: ScoredChunk[], via: "semantic" | "lexical") => {
		list.forEach((hit, rank) => {
			const existing = merged.get(hit.chunk.id)
			const contribution = 1 / (k + rank + 1)
			if (existing) {
				existing.score += contribution
				existing.via.push(via)
			} else {
				merged.set(hit.chunk.id, { chunk: hit.chunk, score: contribution, via: [via] })
			}
		})
	}
	add(semantic, "semantic")
	add(lexical, "lexical")
	return Array.from(merged.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
}

/**
 * Semantic + lexical index of one workspace. Incremental: files whose content
 * hash is unchanged keep their chunks and vectors; changed files are
 * re-chunked and re-embedded; deleted files drop out. Embedding failures
 * degrade the whole index to lexical mode rather than failing the build.
 */
export class CodebaseIndex {
	private manifest: IndexManifest
	private vectors: Float32Array[] = []
	private lexical = new LexicalIndex()
	private readonly store: IndexStore
	private readonly maxFileBytes: number
	private readonly maxChunks: number
	private building = false
	private lastError: string | undefined
	private embedder: Embedder | undefined
	private pending: Promise<void> = Promise.resolve()

	constructor(private readonly options: CodebaseIndexOptions) {
		this.store = new IndexStore(options.storeDir)
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
		this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS
		this.embedder = options.embedder
		this.manifest = this.emptyManifest()
	}

	private emptyManifest(): IndexManifest {
		return {
			version: INDEX_MANIFEST_VERSION,
			root: this.options.root,
			embedder: this.embedder?.id ?? null,
			dims: 0,
			files: {},
			chunks: [],
			updatedAt: 0,
		}
	}

	private log(message: string): void {
		this.options.log?.(`[codebase-index] ${message}`)
	}

	status(): IndexStatus {
		return {
			files: Object.keys(this.manifest.files).length,
			chunks: this.manifest.chunks.length,
			mode: this.manifest.embedder ?? "lexical",
			updatedAt: this.manifest.updatedAt || undefined,
			building: this.building,
			lastError: this.lastError,
		}
	}

	/** Load the persisted index; a stale embedder id or format starts over. */
	async load(): Promise<boolean> {
		const loaded = await this.store.load()
		if (!loaded || loaded.manifest.root !== this.options.root) {
			return false
		}
		const wantEmbedder = this.embedder?.id ?? null
		if (loaded.manifest.embedder !== wantEmbedder) {
			// Different (or no) embedder now: keep lexical data but drop vectors so
			// the next update re-embeds everything consistently.
			this.manifest = { ...loaded.manifest, embedder: wantEmbedder, dims: 0 }
			this.vectors = []
			for (const file of Object.values(this.manifest.files)) {
				file.hash = "" // force re-chunk + re-embed on next update
			}
		} else {
			this.manifest = loaded.manifest
			this.vectors = loaded.vectors
		}
		this.lexical = new LexicalIndex(this.manifest.chunks)
		return true
	}

	/** Serialise updates: concurrent callers wait for the previous one. */
	update(paths?: string[], signal?: AbortSignal): Promise<void> {
		const run = this.pending.then(() => this.doUpdate(paths, signal))
		this.pending = run.catch(() => undefined)
		return run
	}

	private async doUpdate(paths: string[] | undefined, signal?: AbortSignal): Promise<void> {
		this.building = true
		this.lastError = undefined
		try {
			const allFiles = paths ? undefined : new Set(await listIndexableFiles(this.options.root))
			const candidates = paths
				? paths.map((p) => toPosix(path.isAbsolute(p) ? path.relative(this.options.root, p) : p))
				: Array.from(allFiles ?? [])

			const nextFiles: Record<string, { hash: string; chunkIds: string[] }> = { ...this.manifest.files }
			const chunkById = new Map<string, { chunk: CodeChunk; vector: Float32Array | undefined }>(
				this.manifest.chunks.map((c, i) => [c.id, { chunk: c, vector: this.vectors[i] }]),
			)
			const toEmbed: CodeChunk[] = []

			// Deletions on a full rebuild.
			if (allFiles) {
				for (const known of Object.keys(nextFiles)) {
					if (!allFiles.has(known)) {
						for (const id of nextFiles[known].chunkIds) {
							chunkById.delete(id)
						}
						delete nextFiles[known]
					}
				}
			}

			for (const rel of candidates) {
				if (signal?.aborted) {
					throw new Error("index update aborted")
				}
				if (looksBinary(rel) || rel.split("/").some((s) => ALWAYS_SKIP_DIRS.has(s))) {
					continue
				}
				const abs = path.join(this.options.root, rel)
				let content: string
				try {
					const info = await stat(abs)
					if (!info.isFile()) {
						// Removed or not a file: forget it.
						for (const id of nextFiles[rel]?.chunkIds ?? []) {
							chunkById.delete(id)
						}
						delete nextFiles[rel]
						continue
					}
					if (info.size > this.maxFileBytes) {
						continue
					}
					content = await readFile(abs, "utf8")
				} catch {
					for (const id of nextFiles[rel]?.chunkIds ?? []) {
						chunkById.delete(id)
					}
					delete nextFiles[rel]
					continue
				}
				if (content.includes("\0")) {
					continue
				}
				const hash = sha1(content)
				if (nextFiles[rel]?.hash === hash) {
					continue
				}
				for (const id of nextFiles[rel]?.chunkIds ?? []) {
					chunkById.delete(id)
				}
				const chunks = chunkFile(rel, content)
				nextFiles[rel] = { hash, chunkIds: chunks.map((c) => c.id) }
				for (const chunk of chunks) {
					chunkById.set(chunk.id, { chunk, vector: undefined })
					toEmbed.push(chunk)
				}
			}

			// Chunk cap: keep the first N files' chunks deterministically.
			let entries = Array.from(chunkById.values())
			if (entries.length > this.maxChunks) {
				this.log(`chunk cap ${this.maxChunks} reached (${entries.length}); indexing a prefix of the repository`)
				const keep = new Set(entries.slice(0, this.maxChunks).map((e) => e.chunk.id))
				entries = entries.filter((e) => keep.has(e.chunk.id))
				for (const file of Object.values(nextFiles)) {
					file.chunkIds = file.chunkIds.filter((id) => keep.has(id))
				}
			}

			let embedder = this.embedder
			if (embedder) {
				const need = entries.filter((e) => !e.vector)
				if (need.length > 0) {
					try {
						const vectors = await embedder.embed(
							need.map((e) => `${e.chunk.path}\n${e.chunk.text}`),
							signal,
						)
						need.forEach((e, i) => {
							e.vector = vectors[i]
						})
					} catch (error) {
						if (error instanceof EmbeddingUnavailableError) {
							this.log(`embeddings unavailable, falling back to lexical search: ${error.message}`)
							this.lastError = `Эмбеддинги недоступны (${error.status ?? "сеть"}), работает лексический поиск.`
							embedder = undefined
							this.embedder = undefined
						} else {
							throw error
						}
					}
				}
			}

			const chunks = entries.map((e) => e.chunk)
			const dims = embedder ? (entries.find((e) => e.vector)?.vector?.length ?? 0) : 0
			this.manifest = {
				version: INDEX_MANIFEST_VERSION,
				root: this.options.root,
				embedder: embedder && dims > 0 ? embedder.id : null,
				dims,
				files: nextFiles,
				chunks,
				updatedAt: Date.now(),
			}
			this.vectors = embedder && dims > 0 ? entries.map((e) => e.vector ?? new Float32Array(dims)) : []
			this.lexical = new LexicalIndex(chunks)
			await this.store.save(this.manifest, this.vectors)
			this.log(
				`indexed ${chunks.length} chunks from ${Object.keys(nextFiles).length} files (${this.manifest.embedder ?? "lexical"})`,
			)
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error)
			throw error
		} finally {
			this.building = false
		}
	}

	async search(query: string, limit = 10, signal?: AbortSignal): Promise<SearchHit[]> {
		const trimmed = query.trim()
		if (!trimmed || this.manifest.chunks.length === 0) {
			return []
		}
		const lexical = this.lexical.search(trimmed, limit * 3)
		let semantic: ScoredChunk[] = []
		if (this.embedder && this.manifest.embedder === this.embedder.id && this.vectors.length === this.manifest.chunks.length) {
			try {
				const [q] = await this.embedder.embed([trimmed], signal)
				semantic = this.manifest.chunks
					.map((chunk, i) => ({ chunk, score: dot(q, this.vectors[i]) }))
					.sort((a, b) => b.score - a.score)
					.slice(0, limit * 3)
			} catch (error) {
				this.log(`query embedding failed, lexical only: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return fuseRankings(semantic, lexical, limit)
	}

	async clear(): Promise<void> {
		await this.store.clear()
		this.manifest = this.emptyManifest()
		this.vectors = []
		this.lexical = new LexicalIndex()
	}
}
