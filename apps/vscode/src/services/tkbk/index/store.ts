import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CodeChunk } from "./chunker"

export interface IndexedFile {
	/** sha1 of the file content at index time */
	hash: string
	chunkIds: string[]
}

export interface IndexManifest {
	version: 1
	/** workspace root the index was built for */
	root: string
	/** embedder id, or null for a lexical-only index */
	embedder: string | null
	dims: number
	files: Record<string, IndexedFile>
	chunks: CodeChunk[]
	updatedAt: number
}

export const INDEX_MANIFEST_VERSION = 1

/**
 * On-disk layout under `~/.tkbk/index/<repo-hash>/`:
 *   manifest.json — files, chunks (with text) and the embedder id
 *   vectors.bin   — Float32 rows in chunk order (absent for lexical-only)
 * Writes go through a temp file + rename so a crash never leaves a torn index.
 */
export class IndexStore {
	constructor(readonly dir: string) {}

	private get manifestPath(): string {
		return path.join(this.dir, "manifest.json")
	}

	private get vectorsPath(): string {
		return path.join(this.dir, "vectors.bin")
	}

	async load(): Promise<{ manifest: IndexManifest; vectors: Float32Array[] } | undefined> {
		let manifest: IndexManifest
		try {
			manifest = JSON.parse(await readFile(this.manifestPath, "utf8")) as IndexManifest
		} catch {
			return undefined
		}
		if (manifest.version !== INDEX_MANIFEST_VERSION || !Array.isArray(manifest.chunks)) {
			return undefined
		}
		let vectors: Float32Array[] = []
		if (manifest.embedder && manifest.dims > 0) {
			try {
				const buffer = await readFile(this.vectorsPath)
				const floats = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
				if (floats.length !== manifest.chunks.length * manifest.dims) {
					return undefined
				}
				vectors = manifest.chunks.map((_, i) => floats.slice(i * manifest.dims, (i + 1) * manifest.dims))
			} catch {
				return undefined
			}
		}
		return { manifest, vectors }
	}

	async save(manifest: IndexManifest, vectors: Float32Array[]): Promise<void> {
		await mkdir(this.dir, { recursive: true })
		const manifestTmp = `${this.manifestPath}.tmp`
		await writeFile(manifestTmp, JSON.stringify(manifest), "utf8")
		if (manifest.embedder && manifest.dims > 0) {
			const flat = new Float32Array(vectors.length * manifest.dims)
			vectors.forEach((vector, i) => flat.set(vector, i * manifest.dims))
			const vectorsTmp = `${this.vectorsPath}.tmp`
			await writeFile(vectorsTmp, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
			await rename(vectorsTmp, this.vectorsPath)
		} else {
			await rm(this.vectorsPath, { force: true })
		}
		await rename(manifestTmp, this.manifestPath)
	}

	async clear(): Promise<void> {
		await rm(this.dir, { recursive: true, force: true })
	}
}
