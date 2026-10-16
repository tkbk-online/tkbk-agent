import { randomUUID } from "node:crypto"
import path from "node:path"

export type BackgroundTaskStatus =
	| "queued"
	| "preparing"
	| "running"
	| "done"
	| "failed"
	| "applying"
	| "applied"
	| "rejected"
	| "cancelled"

export interface BackgroundTask {
	id: string
	title: string
	prompt: string
	status: BackgroundTaskStatus
	/** repository the task was started from (the open workspace folder) */
	repoPath: string
	/** worktree the agent works in */
	worktreePath: string
	branch: string
	baseBranch: string
	createdAt: number
	startedAt?: number
	finishedAt?: number
	/** the agent's final report */
	summary?: string
	error?: string
	/** files changed in the worktree relative to the base branch */
	changedFiles?: string[]
	/** sessionId of the headless agent session (for history) */
	sessionId?: string
	/** why the task is still queued, e.g. the Free plan limit */
	waitReason?: string
}

/** What a task needs from git. Implemented with simple-git; faked in tests. */
export interface BackgroundGitOps {
	currentBranch(repoPath: string): Promise<string>
	createWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch: string): Promise<void>
	/** stage and commit everything in the worktree; false when nothing changed */
	commitAll(worktreePath: string, message: string): Promise<boolean>
	changedFiles(worktreePath: string, baseBranch: string): Promise<string[]>
	/** unified diff of the task branch against the base */
	diff(worktreePath: string, baseBranch: string): Promise<string>
	/** apply the branch's changes onto the repository's working tree (3-way); throws on conflict */
	applyBranch(repoPath: string, branch: string, baseBranch: string): Promise<void>
	removeWorktree(repoPath: string, worktreePath: string): Promise<void>
	deleteBranch(repoPath: string, branch: string): Promise<void>
}

export interface BackgroundTaskRunner {
	/** run the agent in the worktree and resolve with its final report */
	run(task: BackgroundTask, signal: AbortSignal, onSession?: (sessionId: string) => void): Promise<string>
}

export interface BackgroundTaskManagerOptions {
	git: BackgroundGitOps
	runner: BackgroundTaskRunner
	/** how many tasks may run at once right now (license dependent) */
	maxConcurrent: () => number
	/** text shown on queued tasks when the limit holds them back */
	limitReason?: () => string | undefined
	/** where worktrees go: default `<parent of repo>/.tkbk-worktrees/<repo name>` */
	worktreesRoot?: (repoPath: string) => string
	log?: (message: string) => void
	now?: () => number
}

export function slugify(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
	return base || "task"
}

/**
 * Queue of background agent tasks. Each task gets its own git worktree and
 * branch (`tkbk/<slug>-<id>`); the agent runs headless there, the result is
 * committed on the branch, and the person decides: apply onto the working
 * tree (3-way), open the worktree, or reject (worktree and branch removed).
 */
export class BackgroundTaskManager {
	private readonly tasks = new Map<string, BackgroundTask>()
	private readonly controllers = new Map<string, AbortController>()
	private readonly listeners = new Set<() => void>()
	private readonly now: () => number

	constructor(private readonly options: BackgroundTaskManagerOptions) {
		this.now = options.now ?? (() => Date.now())
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// observers never break the queue
			}
		}
	}

	private log(message: string): void {
		this.options.log?.(`[background-tasks] ${message}`)
	}

	list(): BackgroundTask[] {
		return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id)
	}

	running(): number {
		return this.list().filter((t) => t.status === "preparing" || t.status === "running").length
	}

	enqueue(input: { title: string; prompt: string; repoPath: string }): BackgroundTask {
		const id = randomUUID().slice(0, 8)
		const slug = slugify(input.title)
		const repoName = path.basename(input.repoPath)
		const root =
			this.options.worktreesRoot?.(input.repoPath) ?? path.join(path.dirname(input.repoPath), ".tkbk-worktrees", repoName)
		const task: BackgroundTask = {
			id,
			title: input.title.trim() || input.prompt.slice(0, 60),
			prompt: input.prompt,
			status: "queued",
			repoPath: input.repoPath,
			worktreePath: path.join(root, `${slug}-${id}`),
			branch: `tkbk/${slug}-${id}`,
			baseBranch: "",
			createdAt: this.now(),
		}
		this.tasks.set(id, task)
		this.emit()
		void this.pump()
		return task
	}

	/** Start queued tasks while there is capacity. */
	private async pump(): Promise<void> {
		const limit = Math.max(1, this.options.maxConcurrent())
		const queued = this.list()
			.filter((t) => t.status === "queued")
			.sort((a, b) => a.createdAt - b.createdAt)
		for (const task of queued) {
			if (this.running() >= limit) {
				task.waitReason = this.options.limitReason?.() ?? `Очередь: одновременно не больше ${limit}`
				continue
			}
			task.waitReason = undefined
			void this.start(task)
		}
		this.emit()
	}

	private async start(task: BackgroundTask): Promise<void> {
		const controller = new AbortController()
		this.controllers.set(task.id, controller)
		task.status = "preparing"
		task.startedAt = this.now()
		this.emit()
		try {
			task.baseBranch = await this.options.git.currentBranch(task.repoPath)
			await this.options.git.createWorktree(task.repoPath, task.worktreePath, task.branch, task.baseBranch)
			if (controller.signal.aborted) {
				throw new Error("cancelled")
			}
			task.status = "running"
			this.emit()
			const summary = await this.options.runner.run(task, controller.signal, (sessionId) => {
				task.sessionId = sessionId
				this.emit()
			})
			if (controller.signal.aborted) {
				throw new Error("cancelled")
			}
			const committed = await this.options.git.commitAll(task.worktreePath, `TKBK Agent: ${task.title}`)
			task.changedFiles = committed ? await this.options.git.changedFiles(task.worktreePath, task.baseBranch) : []
			task.summary = summary
			task.status = "done"
			task.finishedAt = this.now()
			this.log(`task ${task.id} done, ${task.changedFiles.length} files changed`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			task.finishedAt = this.now()
			if (controller.signal.aborted || message === "cancelled") {
				task.status = "cancelled"
				task.error = undefined
			} else {
				task.status = "failed"
				task.error = message
				this.log(`task ${task.id} failed: ${message}`)
			}
		} finally {
			this.controllers.delete(task.id)
			this.emit()
			void this.pump()
		}
	}

	cancel(id: string): void {
		const task = this.tasks.get(id)
		if (!task) {
			return
		}
		if (task.status === "queued") {
			task.status = "cancelled"
			task.finishedAt = this.now()
			this.emit()
			return
		}
		this.controllers.get(id)?.abort()
	}

	async diff(id: string): Promise<string> {
		const task = this.require(id)
		return this.options.git.diff(task.worktreePath, task.baseBranch)
	}

	/** Apply the task branch onto the repository's working tree, then clean up. */
	async apply(id: string): Promise<void> {
		const task = this.require(id)
		if (task.status !== "done") {
			throw new Error("Применить можно только завершённую задачу")
		}
		task.status = "applying"
		this.emit()
		try {
			if ((task.changedFiles?.length ?? 0) > 0) {
				await this.options.git.applyBranch(task.repoPath, task.branch, task.baseBranch)
			}
			await this.cleanup(task)
			task.status = "applied"
		} catch (error) {
			task.status = "done"
			task.error = error instanceof Error ? error.message : String(error)
			throw error
		} finally {
			this.emit()
		}
	}

	/** Drop the worktree and branch without applying anything. */
	async reject(id: string): Promise<void> {
		const task = this.require(id)
		if (task.status === "running" || task.status === "preparing") {
			this.cancel(id)
			return
		}
		await this.cleanup(task)
		task.status = "rejected"
		this.emit()
	}

	/** Forget a finished task (its worktree is kept if it still exists). */
	remove(id: string): void {
		const task = this.tasks.get(id)
		if (!task || task.status === "running" || task.status === "preparing") {
			return
		}
		this.tasks.delete(id)
		this.emit()
	}

	private async cleanup(task: BackgroundTask): Promise<void> {
		try {
			await this.options.git.removeWorktree(task.repoPath, task.worktreePath)
		} catch (error) {
			this.log(`worktree not removed: ${error instanceof Error ? error.message : String(error)}`)
		}
		try {
			await this.options.git.deleteBranch(task.repoPath, task.branch)
		} catch (error) {
			this.log(`branch not deleted: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private require(id: string): BackgroundTask {
		const task = this.tasks.get(id)
		if (!task) {
			throw new Error(`Задача ${id} не найдена`)
		}
		return task
	}

	dispose(): void {
		for (const controller of this.controllers.values()) {
			controller.abort()
		}
		this.controllers.clear()
		this.listeners.clear()
	}
}

/** Human-readable status for the tree view. */
export function describeStatus(task: BackgroundTask): string {
	switch (task.status) {
		case "queued":
			return task.waitReason ? `в очереди — ${task.waitReason}` : "в очереди"
		case "preparing":
			return "создаём worktree…"
		case "running":
			return "выполняется…"
		case "done":
			return `готово, файлов: ${task.changedFiles?.length ?? 0}`
		case "failed":
			return `ошибка: ${task.error ?? "неизвестно"}`
		case "applying":
			return "применяем…"
		case "applied":
			return "применено"
		case "rejected":
			return "отклонено"
		case "cancelled":
			return "отменено"
	}
}
