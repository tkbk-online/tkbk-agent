import * as vscode from "vscode"
import { type BackgroundTask, type BackgroundTaskManager, describeStatus } from "@/services/tkbk/background/background-tasks"

export const BACKGROUND_TASKS_VIEW_ID = "tkbk-agent.backgroundTasks"

const STATUS_ICONS: Record<BackgroundTask["status"], string> = {
	queued: "clock",
	preparing: "sync~spin",
	running: "sync~spin",
	done: "check",
	failed: "error",
	applying: "sync~spin",
	applied: "check-all",
	rejected: "circle-slash",
	cancelled: "circle-slash",
}

/** Tree item for one background task; `contextValue` drives the context menu. */
export class BackgroundTaskItem extends vscode.TreeItem {
	constructor(readonly task: BackgroundTask) {
		super(task.title, vscode.TreeItemCollapsibleState.None)
		this.id = task.id
		this.description = describeStatus(task)
		this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[task.status])
		this.contextValue = `tkbkTask:${task.status}`
		const lines = [task.prompt, "", `Ветка: ${task.branch}`, `Worktree: ${task.worktreePath}`]
		if (task.summary) {
			lines.push("", task.summary.slice(0, 1_500))
		}
		if (task.error) {
			lines.push("", `Ошибка: ${task.error}`)
		}
		this.tooltip = new vscode.MarkdownString(lines.join("\n"))
		if (task.status === "done") {
			this.command = { command: "tkbk-agent.backgroundTask.showReport", title: "Отчёт", arguments: [this] }
		}
	}
}

export class BackgroundTasksProvider implements vscode.TreeDataProvider<BackgroundTaskItem>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<BackgroundTaskItem | undefined>()
	readonly onDidChangeTreeData = this.emitter.event
	private readonly unsubscribe: () => void

	constructor(private readonly manager: BackgroundTaskManager) {
		this.unsubscribe = manager.onDidChange(() => this.emitter.fire(undefined))
	}

	getTreeItem(element: BackgroundTaskItem): vscode.TreeItem {
		return element
	}

	getChildren(): BackgroundTaskItem[] {
		return this.manager.list().map((task) => new BackgroundTaskItem(task))
	}

	refresh(): void {
		this.emitter.fire(undefined)
	}

	dispose(): void {
		this.unsubscribe()
		this.emitter.dispose()
	}
}

export interface BackgroundTasksUiOptions {
	manager: BackgroundTaskManager
	getRepoPath: () => Promise<string | undefined>
	/** command id prefix, e.g. "tkbk-agent" */
	commandPrefix: string
	/** text shown when the plan caps parallel tasks */
	planHint?: () => string | undefined
}

/**
 * Registers the «Фоновые задачи» tree view and its commands. The view itself
 * is contributed in package.json under the TKBK container.
 */
export function registerBackgroundTasksUi(context: vscode.ExtensionContext, options: BackgroundTasksUiOptions): void {
	const { manager, commandPrefix: p } = options
	const provider = new BackgroundTasksProvider(manager)
	context.subscriptions.push(provider, vscode.window.registerTreeDataProvider(BACKGROUND_TASKS_VIEW_ID, provider))

	const taskOf = (item?: BackgroundTaskItem): BackgroundTask | undefined => item?.task ?? undefined

	context.subscriptions.push(
		vscode.commands.registerCommand(`${p}.backgroundTask.new`, async () => {
			const repoPath = await options.getRepoPath()
			if (!repoPath) {
				void vscode.window.showWarningMessage(
					"TKBK Agent: откройте папку с git-репозиторием, чтобы запускать фоновые задачи.",
				)
				return
			}
			const prompt = await vscode.window.showInputBox({
				title: "Фоновая задача TKBK Agent",
				prompt: "Опишите, что сделать. Агент выполнит это в отдельном git worktree, не мешая вашей работе.",
				placeHolder: "Например: добавить экспорт заказов в CSV и тесты к нему",
				ignoreFocusOut: true,
			})
			if (!prompt?.trim()) {
				return
			}
			const task = manager.enqueue({ title: prompt.trim().split(/\r?\n/)[0].slice(0, 60), prompt: prompt.trim(), repoPath })
			const hint = options.planHint?.()
			void vscode.window.showInformationMessage(
				`TKBK Agent: задача «${task.title}» ${task.status === "running" || task.status === "preparing" ? "запущена" : "поставлена в очередь"}.${hint ? ` ${hint}` : ""}`,
			)
			await vscode.commands.executeCommand(`${BACKGROUND_TASKS_VIEW_ID}.focus`).then(undefined, () => undefined)
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.refresh`, () => provider.refresh()),
		vscode.commands.registerCommand(`${p}.backgroundTask.cancel`, (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (task) {
				manager.cancel(task.id)
			}
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.apply`, async (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (!task) {
				return
			}
			try {
				await manager.apply(task.id)
				void vscode.window.showInformationMessage(
					`TKBK Agent: изменения задачи «${task.title}» применены в рабочую копию.`,
				)
			} catch (error) {
				void vscode.window.showErrorMessage(`TKBK Agent: ${error instanceof Error ? error.message : String(error)}`)
			}
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.reject`, async (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (!task) {
				return
			}
			const answer = await vscode.window.showWarningMessage(
				`Отклонить задачу «${task.title}»? Worktree и ветка ${task.branch} будут удалены.`,
				{ modal: true },
				"Отклонить",
			)
			if (answer === "Отклонить") {
				await manager.reject(task.id)
			}
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.open`, async (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (task) {
				await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(task.worktreePath), {
					forceNewWindow: true,
				})
			}
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.showDiff`, async (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (!task) {
				return
			}
			try {
				const diff = await manager.diff(task.id)
				const doc = await vscode.workspace.openTextDocument({ language: "diff", content: diff || "(изменений нет)" })
				await vscode.window.showTextDocument(doc, { preview: true })
			} catch (error) {
				void vscode.window.showErrorMessage(`TKBK Agent: ${error instanceof Error ? error.message : String(error)}`)
			}
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.showReport`, async (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (!task) {
				return
			}
			const content = [
				`# ${task.title}`,
				"",
				`Статус: ${describeStatus(task)}`,
				`Ветка: ${task.branch} (от ${task.baseBranch})`,
				`Worktree: ${task.worktreePath}`,
				"",
				"## Задание",
				task.prompt,
				"",
				"## Отчёт агента",
				task.summary ?? task.error ?? "—",
				"",
				"## Изменённые файлы",
				...(task.changedFiles?.length ? task.changedFiles.map((f) => `- ${f}`) : ["—"]),
			].join("\n")
			const doc = await vscode.workspace.openTextDocument({ language: "markdown", content })
			await vscode.window.showTextDocument(doc, { preview: true })
		}),
		vscode.commands.registerCommand(`${p}.backgroundTask.remove`, (item?: BackgroundTaskItem) => {
			const task = taskOf(item)
			if (task) {
				manager.remove(task.id)
			}
		}),
	)
}
