import path from "node:path"
import { resolveTkbkDir } from "@cline/shared/storage"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { resolveApiKey } from "@/sdk/cline-session-factory"
import { Logger } from "@/shared/services/Logger"
import { CodebaseIndex, repoHash } from "./codebase-index"
import { type Embedder, GatewayEmbedder } from "./embedder"

export const TKBK_GATEWAY_BASE_URL = "https://api.tkbk.online/v1"
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"

export interface IndexSettings {
	enabled: boolean
	useEmbeddings: boolean
	embeddingModel: string
	maxFileKb: number
}

export function readIndexSettings(): IndexSettings {
	const cfg = vscode.workspace.getConfiguration("tkbk-agent.index")
	return {
		enabled: cfg.get<boolean>("enabled", true),
		useEmbeddings: cfg.get<boolean>("useEmbeddings", true),
		embeddingModel: cfg.get<string>("embeddingModel", DEFAULT_EMBEDDING_MODEL),
		maxFileKb: cfg.get<number>("maxFileKb", 200),
	}
}

/**
 * Embeddings go through the TKBK gateway with the person's own key, so they
 * exist only while the active provider is TKBK and a key is saved. Any other
 * setup indexes lexically.
 */
export function resolveEmbedder(settings: IndexSettings): Embedder | undefined {
	if (!settings.useEmbeddings) {
		return undefined
	}
	try {
		const api = StateManager.get().getApiConfiguration()
		const provider = api.actModeApiProvider ?? api.planModeApiProvider
		if (provider !== "tkbk") {
			return undefined
		}
		const apiKey = resolveApiKey("tkbk", api)?.trim()
		if (!apiKey) {
			return undefined
		}
		return new GatewayEmbedder({ baseUrl: TKBK_GATEWAY_BASE_URL, apiKey, model: settings.embeddingModel })
	} catch (error) {
		Logger.warn("[TKBK index] embedder unavailable:", error)
		return undefined
	}
}

export interface IndexHost {
	/** absolute paths of the open workspace folders */
	getWorkspaceRoots: () => readonly string[]
	/** notify on create/change/delete of any file; returns a disposer */
	watchFiles: (onChange: (fsPath: string) => void) => { dispose(): void }
	onWorkspaceFoldersChanged: (listener: () => void) => { dispose(): void }
	onSettingsChanged: (listener: () => void) => { dispose(): void }
	readSettings: () => IndexSettings
	resolveEmbedder: (settings: IndexSettings) => Embedder | undefined
	log?: (message: string) => void
}

const WATCH_DEBOUNCE_MS = 1_500

/**
 * One {@link CodebaseIndex} per workspace folder, built in the background on
 * activation, kept fresh by a file watcher (debounced), rebuilt when the
 * settings or the provider change. Exposes the index the `codebase_search`
 * tool reads. The VS Code specifics (watchers, folders) come in through
 * {@link IndexHost} so the manager stays testable and lint-clean.
 */
export class TkbkIndexManager {
	private readonly indexes = new Map<string, CodebaseIndex>()
	private readonly disposables: Array<{ dispose(): void }> = []
	private readonly pendingPaths = new Map<string, Set<string>>()
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
	private settings: IndexSettings

	constructor(private readonly host: IndexHost) {
		this.settings = host.readSettings()
	}

	private log(message: string): void {
		;(this.host.log ?? ((m: string) => Logger.log(m)))(message)
	}

	start(): void {
		this.disposables.push(
			this.host.onSettingsChanged(() => {
				this.settings = this.host.readSettings()
				void this.rebuildAll()
			}),
			this.host.onWorkspaceFoldersChanged(() => void this.syncFolders()),
			this.host.watchFiles((fsPath) => this.enqueue(fsPath)),
		)
		void this.syncFolders()
	}

	/** The index for the folder that contains `cwd`, if indexing is on. */
	getIndex(cwd: string | undefined): CodebaseIndex | undefined {
		if (!this.settings.enabled) {
			return undefined
		}
		const root = this.rootFor(cwd)
		return root ? this.indexes.get(root) : undefined
	}

	async rebuildAll(): Promise<void> {
		for (const [root, index] of this.indexes) {
			await index.clear().catch(() => undefined)
			this.indexes.delete(root)
		}
		await this.syncFolders()
	}

	/** Re-create the embedder (provider or key changed) and refresh vectors. */
	async onProviderChanged(): Promise<void> {
		await this.rebuildAll()
	}

	private roots(): string[] {
		return this.host.getWorkspaceRoots().map((r) => path.resolve(r))
	}

	private rootFor(cwd: string | undefined): string | undefined {
		const roots = this.roots()
		if (!cwd) {
			return roots[0]
		}
		const normalized = path.resolve(cwd)
		for (const root of this.indexes.keys()) {
			if (normalized === root || normalized.startsWith(root + path.sep)) {
				return root
			}
		}
		return roots[0]
	}

	private async syncFolders(): Promise<void> {
		if (!this.settings.enabled) {
			return
		}
		const roots = this.roots()
		for (const root of roots) {
			if (!this.indexes.has(root)) {
				const index = new CodebaseIndex({
					root,
					storeDir: path.join(resolveTkbkDir(), "index", repoHash(root)),
					embedder: this.host.resolveEmbedder(this.settings),
					maxFileBytes: this.settings.maxFileKb * 1024,
					log: (m) => this.log(m),
				})
				this.indexes.set(root, index)
				void index
					.load()
					.then(() => index.update())
					.catch((error) =>
						this.log(
							`[codebase-index] build failed for ${root}: ${error instanceof Error ? error.message : String(error)}`,
						),
					)
			}
		}
		for (const root of Array.from(this.indexes.keys())) {
			if (!roots.includes(root)) {
				this.indexes.delete(root)
			}
		}
	}

	private enqueue(file: string): void {
		const root = Array.from(this.indexes.keys()).find((r) => file === r || file.startsWith(r + path.sep))
		if (!root) {
			return
		}
		const rel = path.relative(root, file)
		if (rel.split(path.sep).some((s) => s === ".git" || s === "node_modules" || s === ".tkbk")) {
			return
		}
		let set = this.pendingPaths.get(root)
		if (!set) {
			set = new Set()
			this.pendingPaths.set(root, set)
		}
		set.add(rel)
		const timer = this.timers.get(root)
		if (timer) {
			clearTimeout(timer)
		}
		this.timers.set(
			root,
			setTimeout(() => {
				this.timers.delete(root)
				const paths = Array.from(this.pendingPaths.get(root) ?? [])
				this.pendingPaths.delete(root)
				const index = this.indexes.get(root)
				if (index && paths.length > 0) {
					void index
						.update(paths)
						.catch((error) =>
							this.log(`[codebase-index] update failed: ${error instanceof Error ? error.message : String(error)}`),
						)
				}
			}, WATCH_DEBOUNCE_MS),
		)
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer)
		}
		this.timers.clear()
		for (const d of this.disposables) {
			d.dispose()
		}
		this.disposables.length = 0
	}
}

let current: TkbkIndexManager | undefined

export function setTkbkIndexManager(manager: TkbkIndexManager | undefined): void {
	current = manager
}

export function getTkbkIndexManager(): TkbkIndexManager | undefined {
	return current
}
