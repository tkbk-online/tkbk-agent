import { ClineCore } from "@cline/core"
import { buildSessionConfig } from "@/sdk/cline-session-factory"
import { getDistinctId } from "@/services/logging/distinctId"
import { Logger } from "@/shared/services/Logger"
import type { BackgroundTask, BackgroundTaskRunner } from "./background-tasks"

const BACKGROUND_SYSTEM_ADDENDUM = `

# Фоновый режим TKBK Agent
Ты работаешь в фоне, в отдельном git worktree; никто не отвечает на вопросы в реальном времени, и подтверждения на инструменты не нужны.
- Не задавай вопросов пользователю: принимай разумные решения сам и перечисли их в итоговом отчёте.
- Правь только файлы внутри текущей рабочей папки. Ничего не коммить, не пуши и не меняй ветки — результат заберут из worktree.
- Запускай проверки проекта (тесты, сборку), если они есть; не чини среду разработки и не устанавливай глобальные пакеты.
- Закончи кратким отчётом по-русски: что сделано, какие файлы затронуты, что проверено, что осталось.`

/**
 * Runs one background task headless: a fresh ClineCore in local mode without
 * an approval handler (tools execute autonomously) and with every tool
 * auto-approved, pointed at the task's worktree. Resolves with the agent's
 * final report.
 */
export class HeadlessBackgroundRunner implements BackgroundTaskRunner {
	async run(task: BackgroundTask, signal: AbortSignal, onSession?: (sessionId: string) => void): Promise<string> {
		const config = await buildSessionConfig({
			prompt: task.prompt,
			cwd: task.worktreePath,
			workspaceRoot: task.worktreePath,
			mode: "act",
		})
		const core = await ClineCore.create({
			backendMode: "local",
			toolPolicies: { "*": { autoApprove: true } },
			distinctId: getDistinctId() || undefined,
		})
		let sessionId: string | undefined
		const abort = () => {
			if (sessionId) {
				void core.abort(sessionId, new Error("Фоновая задача отменена")).catch(() => undefined)
			}
		}
		signal.addEventListener("abort", abort, { once: true })
		try {
			const started = await core.start({
				config: {
					...config,
					systemPrompt: `${config.systemPrompt ?? ""}${BACKGROUND_SYSTEM_ADDENDUM}`,
					// Checkpoints track the main workspace; the worktree branch is the record here.
					checkpoint: { enabled: false },
				},
				interactive: false,
				mode: "background",
				source: "vscode",
				sessionMetadata: { tkbkBackgroundTask: task.id, worktree: task.worktreePath },
				toolPolicies: { "*": { autoApprove: true } },
			})
			sessionId = started.sessionId
			onSession?.(sessionId)
			Logger.log(`[background-tasks] session ${sessionId} started for task ${task.id} in ${task.worktreePath}`)
			await core.send({ sessionId, prompt: task.prompt })
			if (signal.aborted) {
				throw new Error("cancelled")
			}
			return await this.finalReport(core, sessionId)
		} finally {
			signal.removeEventListener("abort", abort)
			if (sessionId) {
				await core.stop(sessionId).catch(() => undefined)
			}
			await core.dispose("background task finished").catch(() => undefined)
		}
	}

	private async finalReport(core: ClineCore, sessionId: string): Promise<string> {
		try {
			const messages = await core.readDisplayMessages(sessionId)
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i]?.message
				if (message?.role !== "assistant") {
					continue
				}
				const text = extractText(message.content)
				if (text.trim()) {
					return text.trim()
				}
			}
		} catch (error) {
			Logger.warn("[background-tasks] could not read the final report:", error)
		}
		return "Задача завершена, отчёт агента не найден. Посмотрите diff."
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block && typeof block === "object" && (block as { type?: string }).type === "text"
					? String((block as { text?: string }).text ?? "")
					: "",
			)
			.filter(Boolean)
			.join("\n")
	}
	return ""
}
