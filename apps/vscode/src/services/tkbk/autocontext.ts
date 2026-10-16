import path from "node:path"
import simpleGit from "simple-git"
import { HostProvider } from "@/hosts/host-provider"
import { DiagnosticSeverity } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"

export interface AutocontextDiagnostic {
	file: string
	line: number
	severity: "error" | "warning"
	message: string
	source?: string
}

export interface AutocontextInput {
	cwd: string
	activeFile?: string
	openTabs: string[]
	diagnostics: AutocontextDiagnostic[]
	branch?: string
	/** `git status --short` */
	gitStatus?: string
	/** `git diff --stat` (working tree vs HEAD) */
	gitDiffStat?: string
}

const MAX_TABS = 15
const MAX_DIAGNOSTICS = 20
const MAX_LINES = 30
const MAX_MESSAGE = 160

function rel(cwd: string, file: string): string {
	const r = path.relative(cwd, file)
	return (r && !r.startsWith("..") ? r : file).split(path.sep).join("/")
}

function clip(lines: string[], max: number): string[] {
	return lines.length > max ? [...lines.slice(0, max), `… ещё ${lines.length - max}`] : lines
}

/**
 * Compact snapshot of what the person is looking at and what is broken, for
 * the system prompt. Pure: easy to test, the collector below fills it in.
 * Empty sections are dropped; an entirely empty snapshot renders to "".
 */
export function formatAutocontext(input: AutocontextInput): string {
	const sections: string[] = []
	const tabs = input.openTabs.map((t) => rel(input.cwd, t))
	const active = input.activeFile ? rel(input.cwd, input.activeFile) : undefined
	if (active || tabs.length > 0) {
		const lines: string[] = []
		if (active) {
			lines.push(`Активный файл: ${active}`)
		}
		const others = tabs.filter((t) => t !== active)
		if (others.length > 0) {
			lines.push(`Открытые вкладки: ${clip(others, MAX_TABS).join(", ")}`)
		}
		sections.push(lines.join("\n"))
	}
	if (input.diagnostics.length > 0) {
		const sorted = [...input.diagnostics].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
		const lines = sorted.map(
			(d) =>
				`- ${d.severity === "error" ? "ошибка" : "предупреждение"} ${rel(input.cwd, d.file)}:${d.line}${d.source ? ` [${d.source}]` : ""} — ${d.message.replace(/\s+/g, " ").slice(0, MAX_MESSAGE)}`,
		)
		const errors = sorted.filter((d) => d.severity === "error").length
		sections.push(
			`Диагностика редактора (ошибок: ${errors}, предупреждений: ${sorted.length - errors}):\n${clip(lines, MAX_DIAGNOSTICS).join("\n")}`,
		)
	}
	const status = input.gitStatus?.trim()
	const stat = input.gitDiffStat?.trim()
	if (input.branch || status || stat) {
		const lines: string[] = []
		if (input.branch) {
			lines.push(`Ветка: ${input.branch}`)
		}
		if (status) {
			lines.push("Незакоммиченные файлы (git status --short):", ...clip(status.split(/\r?\n/), MAX_LINES))
		}
		if (stat) {
			lines.push("Объём правок (git diff --stat):", ...clip(stat.split(/\r?\n/), MAX_LINES))
		}
		sections.push(lines.join("\n"))
	}
	if (sections.length === 0) {
		return ""
	}
	return [
		"# Текущий контекст редактора",
		"Снимок на момент старта задачи; перепроверяй инструментами, если что-то важно.",
		"",
		...sections.flatMap((s) => [s, ""]),
	]
		.join("\n")
		.trimEnd()
}

/**
 * Gather the snapshot through the host bridge (open tabs, active editor,
 * diagnostics) and git. Every source is optional: a failure in one leaves the
 * others in place, and a host without the bridge yields "".
 */
export async function collectAutocontext(cwd: string): Promise<string> {
	const input: AutocontextInput = { cwd, openTabs: [], diagnostics: [] }
	try {
		input.activeFile = (await HostProvider.window.getActiveEditor({})).filePath || undefined
		input.openTabs = (await HostProvider.window.getOpenTabs({})).paths ?? []
	} catch (error) {
		Logger.warn("[autocontext] editor state unavailable:", error)
	}
	try {
		const { fileDiagnostics } = await HostProvider.workspace.getDiagnostics({})
		for (const file of fileDiagnostics ?? []) {
			for (const d of file.diagnostics ?? []) {
				if (d.severity !== DiagnosticSeverity.DIAGNOSTIC_ERROR && d.severity !== DiagnosticSeverity.DIAGNOSTIC_WARNING) {
					continue
				}
				input.diagnostics.push({
					file: file.filePath,
					line: (d.range?.start?.line ?? 0) + 1,
					severity: d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR ? "error" : "warning",
					message: d.message,
					source: d.source || undefined,
				})
			}
		}
	} catch (error) {
		Logger.warn("[autocontext] diagnostics unavailable:", error)
	}
	try {
		const git = simpleGit(cwd)
		if (await git.checkIsRepo()) {
			input.branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
			input.gitStatus = await git.raw(["status", "--short"])
			input.gitDiffStat = await git.raw(["diff", "--stat"])
		}
	} catch (error) {
		Logger.warn("[autocontext] git state unavailable:", error)
	}
	return formatAutocontext(input)
}
