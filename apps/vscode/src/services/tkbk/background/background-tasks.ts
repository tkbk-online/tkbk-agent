import { randomUUID } from "node:crypto"
import path from "node:path"
import type { CloudBackend, CloudSettings } from "../cloud/cloud-backend"
import { TKBK_PRO_BUY_URL } from "../cloud/cloud-backend"
import { TERMINAL_STATUSES, TkbkCloudError } from "../cloud/tkbkCloudAgents"

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

export type BackgroundTaskKind = "local" | "cloud"

export interface BackgroundTask {
	id: string
	kind: BackgroundTaskKind
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
	/** cloud: orchestrator task id, current phase, minutes and the last agent line */
	cloudId?: string
	phase?: string
	minutes?: number
	progress?: string
	/** cloud: unified diff fetched when the task finished */
	patch?: string
	prUrl?: string
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
	/** cloud: `origin` URL, or undefined */
	remoteUrl(repoPath: string): Promise<string | undefined>
	/** cloud: uncommitted changes present */
	isDirty(repoPath: string): Promise<boolean>
	/** cloud: apply a unified diff onto the working tree (3-way); throws on conflict */
	applyPatch(repoPath: string, patch: string): Promise<void>
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
	/** cloud orchestrator; undefined → cloud tasks are refused */
	cloud?: () => CloudBackend | undefined
	cloudSettings?: () => CloudSettings
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
		return this.list().filter((t) => t.kind === "local" && (t.status === "preparing" || t.status === "running")).length
	}

	enqueue(input: { title: string; prompt: string; repoPath: string }): BackgroundTask {
		const id = randomUUID().slice(0, 8)
		const slug = slugify(input.title)
		const repoName = path.basename(input.repoPath)
		const root =
			this.options.worktreesRoot?.(input.repoPath) ?? path.join(path.dirname(input.repoPath), ".tkbk-worktrees", repoName)
		const task: BackgroundTask = {
			id,
			kind: "local",
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

	/**
	 * Cloud task: the orchestrator clones the repository's `origin` at the
	 * current branch, runs the agent in a sandbox and returns a patch. The
	 * plan is checked by the server (403 → Pro offer). Uncommitted changes are
	 * not uploaded in this version, so the working tree must be clean.
	 */
	enqueueCloud(input: { title: string; prompt: string; repoPath: string }): BackgroundTask {
		const id = randomUUID().slice(0, 8)
		const task: BackgroundTask = {
			id,
			kind: "cloud",
			title: input.title.trim() || input.prompt.slice(0, 60),
			prompt: input.prompt,
			status: "queued",
			repoPath: input.repoPath,
			worktreePath: "",
			branch: "",
			baseBranch: "",
			createdAt: this.now(),
		}
		this.tasks.set(id, task)
		this.emit()
		void this.startCloud(task)
		return task
	}

	private async startCloud(task: BackgroundTask): Promise<void> {
		const controller = new AbortController()
		this.controllers.set(task.id, controller)
		task.status = "preparing"
		task.startedAt = this.now()
		this.emit()
		try {
			const backend = this.options.cloud?.()
			if (!backend) {
				throw new Error("Облачные задачи не настроены: нужен ключ TKBK в провайдере TKBK.")
			}
			const settings = this.options.cloudSettings?.() ?? { serverUrl: "", model: "", maxMinutes: 60 }
			const [remote, branch, dirty] = await Promise.all([
				this.options.git.remoteUrl(task.repoPath),
				this.options.git.currentBranch(task.repoPath),
				this.options.git.isDirty(task.repoPath),
			])
			if (!remote) {
				throw new Error(
					"У репозитория нет remote `origin` — облако клонирует репозиторий по URL. Запушьте проект на GitHub/GitLab.",
				)
			}
			if (dirty) {
				throw new Error(
					"Есть незакоммиченные изменения — облако берёт ветку из origin. Закоммитьте и запушьте правки или запустите задачу локально.",
				)
			}
			task.baseBranch = branch
			let me: Awaited<ReturnType<CloudBackend["me"]>>
			try {
				me = await backend.me()
			} catch (error) {
				if (error instanceof TkbkCloudError && error.status === 403) {
					throw new Error(`Облачные задачи доступны на плане Pro и выше. Купить Pro: ${TKBK_PRO_BUY_URL}`)
				}
				if (error instanceof TkbkCloudError && error.status === 401) {
					throw new Error("Сервер облачных задач не принял ключ TKBK. Проверьте ключ в настройках провайдера.")
				}
				const detail = error instanceof Error ? error.message : String(error)
				throw new Error(
					`Сервер облачных задач недоступен (${settings.serverUrl || "адрес не задан"}): ${detail}. Проверьте настройку tkbk-agent.cloud.serverUrl или запустите задачу локально.`,
				)
			}
			if (!me.cloud_agents) {
				throw new Error(
					`Облачные задачи доступны на плане Pro и выше (сейчас: ${me.plan}). Купить Pro: ${TKBK_PRO_BUY_URL}`,
				)
			}
			if (me.minutes_left <= 0) {
				throw new Error(`Часы облачного агента на этот месяц исчерпаны (${me.hours_month} ч в плане ${me.plan}).`)
			}
			const created = await backend.createTask({
				repoUrl: remote,
				branch,
				template: "custom",
				prompt: task.prompt,
				model: settings.model || undefined,
				deliver: "patch",
				maxMinutes: settings.maxMinutes,
				clientRef: `tkbk-agent:${task.id}`,
			})
			task.cloudId = created.task.id
			task.branch = created.task.work_branch ?? ""
			task.status = "running"
			task.phase = created.task.phase
			this.emit()

			let finalStatus: string | undefined
			let finalError: string | null | undefined
			for await (const event of backend.events(created.task.id, { signal: controller.signal })) {
				if (event.type === "status") {
					task.phase = event.phase ?? event.status
				} else if (event.type === "agent") {
					const text = (event.thought || event.text || "").replace(/\s+/g, " ").trim()
					if (text) {
						task.progress = `${event.tool ? `${event.tool}: ` : ""}${text.slice(0, 160)}`
					}
				} else if (event.type === "log" && event.message) {
					task.progress = event.message.slice(0, 160)
				} else if (event.type === "done") {
					finalStatus = event.status
					finalError = event.error
					task.minutes = event.minutes_billed
					if (event.result) {
						task.summary = event.result.summary
						task.changedFiles = event.result.changed_files ?? []
						task.prUrl = event.result.pr_url ?? undefined
						task.branch = event.result.branch ?? task.branch
					}
				}
				this.emit()
				if (controller.signal.aborted) {
					break
				}
			}
			if (controller.signal.aborted) {
				throw new Error("cancelled")
			}
			if (
				finalStatus &&
				TERMINAL_STATUSES.has(finalStatus as never) &&
				finalStatus !== "done" &&
				finalStatus !== "timeout"
			) {
				throw new Error(finalError || `облачная задача завершилась со статусом ${finalStatus}`)
			}
			if (finalStatus === "timeout") {
				task.progress = "Лимит минут исчерпан; применяется то, что успело измениться."
			}
			try {
				task.patch = await backend.diff(created.task.id)
			} catch {
				task.patch = ""
			}
			if (task.patch && !task.changedFiles?.length) {
				task.changedFiles = Array.from(task.patch.matchAll(/^\+\+\+ b\/(.+)$/gm), (m) => m[1])
			}
			task.summary = task.summary ?? "Облачная задача завершена."
			task.status = "done"
			task.finishedAt = this.now()
			this.log(`cloud task ${task.id} (${task.cloudId}) done`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			task.finishedAt = this.now()
			if (controller.signal.aborted || message === "cancelled") {
				task.status = "cancelled"
				task.error = undefined
				if (task.cloudId) {
					void this.options
						.cloud?.()
						?.cancel(task.cloudId)
						.catch(() => undefined)
				}
			} else {
				task.status = "failed"
				task.error = message
				this.log(`cloud task ${task.id} failed: ${message}`)
			}
		} finally {
			this.controllers.delete(task.id)
			this.emit()
		}
	}

	/** Start queued local tasks while there is capacity. */
	private async pump(): Promise<void> {
		const limit = Math.max(1, this.options.maxConcurrent())
		const queued = this.list()
			.filter((t) => t.status === "queued" && t.kind === "local")
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
		if (task.kind === "cloud") {
			return task.patch ?? ""
		}
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
			if (task.kind === "cloud") {
				if (task.patch?.trim()) {
					await this.options.git.applyPatch(task.repoPath, task.patch)
				}
				task.status = "applied"
				return
			}
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
		if (task.kind === "local") {
			await this.cleanup(task)
		}
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
			return task.kind === "cloud" ? "отправляем в облако…" : "создаём worktree…"
		case "running":
			return task.kind === "cloud"
				? `в облаке: ${task.phase ?? "running"}${task.progress ? ` — ${task.progress}` : ""}`
				: "выполняется…"
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
