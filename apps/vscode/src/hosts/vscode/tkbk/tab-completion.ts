import { createHash } from "node:crypto"
import * as vscode from "vscode"
import {
	allowMultiline,
	buildTabRequest,
	extractTabText,
	isSensitiveFile,
	LruCache,
	type MultilinePolicy,
	type PreviousCompletion,
	postProcessTab,
	RecentEdits,
	reuseFromPrevious,
	tabStopSequences,
} from "@/services/tkbk/tab/tab-lib"
import { Logger } from "@/shared/services/Logger"

export const TAB_SETTINGS_SECTION = "tkbk-agent.tab"
export const TAB_DEFAULT_MODEL = "claude-haiku-4-5"
const TAB_CATALOG = [
	"deepseek-v4.1-flash",
	"claude-haiku-4-5",
	"deepseek-v4-pro",
	"glm-5.3",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"grok-4.7",
	"claude-sonnet-5",
]
const GATEWAY_BASE_URL = "https://api.tkbk.online/v1"

export interface TabCompletionOptions {
	/** the saved TKBK key, or undefined */
	getApiKey: () => Promise<string | undefined>
	/** command id prefix, e.g. "tkbk-agent" */
	commandPrefix: string
}

interface TabSettings {
	enabled: boolean
	model: string
	debounceMs: number
	maxTokens: number
	multiline: MultilinePolicy
	contextChars: number
	disabledLanguages: string[]
	timeoutMs: number
}

function readTabSettings(): TabSettings {
	const cfg = vscode.workspace.getConfiguration(TAB_SETTINGS_SECTION)
	return {
		enabled: cfg.get<boolean>("enabled", true),
		model: cfg.get<string>("model", TAB_DEFAULT_MODEL) || TAB_DEFAULT_MODEL,
		debounceMs: cfg.get<number>("debounceMs", 150),
		maxTokens: cfg.get<number>("maxTokens", 160),
		multiline: cfg.get<MultilinePolicy>("multiline", "auto"),
		contextChars: cfg.get<number>("contextChars", 6000),
		disabledLanguages: cfg.get<string[]>("disabledLanguages", []),
		timeoutMs: cfg.get<number>("timeoutMs", 8000),
	}
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(true), ms)
		token.onCancellationRequested(() => {
			clearTimeout(timer)
			resolve(false)
		})
	})
}

/**
 * TKBK Tab inside the agent: grey inline suggestions accepted with Tab, served
 * by a fast model from the TKBK catalog through the gateway with the key the
 * person already saved for the agent. FIM prompt (prefix/suffix), recent edits
 * as context, debounce, cancellation of stale requests, prefix cache and
 * typed-through reuse, single- or multi-line policy.
 */
export class TkbkTabCompletion implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel("TKBK Tab")
	private readonly status: vscode.StatusBarItem
	private readonly cache = new LruCache<string>(64)
	private readonly recentEdits = new RecentEdits()
	private readonly disposables: vscode.Disposable[] = []
	private lastCompletion: PreviousCompletion | undefined
	private failures = 0
	private pausedUntil = 0
	private warnedNoKey = false

	constructor(private readonly options: TabCompletionOptions) {
		this.status = vscode.window.createStatusBarItem(`${options.commandPrefix}.tab`, vscode.StatusBarAlignment.Right, 150)
		this.status.name = "TKBK Tab"
		this.status.command = `${options.commandPrefix}.tab.menu`
		this.status.show()
		this.disposables.push(this.output, this.status)
	}

	private log(...parts: unknown[]): void {
		this.output.appendLine(`[${new Date().toISOString()}] ${parts.map(String).join(" ")}`)
	}

	register(context: vscode.ExtensionContext): void {
		const p = this.options.commandPrefix
		context.subscriptions.push(
			this,
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document.uri.scheme !== "file" || isSensitiveFile(e.document.fileName)) {
					return
				}
				for (const change of e.contentChanges) {
					const line = change.range.start.line
					const from = Math.max(0, line - 1)
					const to = Math.min(e.document.lineCount - 1, line + 1)
					const snippet = e.document.getText(new vscode.Range(from, 0, to, e.document.lineAt(to).text.length))
					this.recentEdits.record({ file: vscode.workspace.asRelativePath(e.document.uri), line: line + 1, snippet })
				}
			}),
			vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, this),
			vscode.commands.registerCommand(`${p}.tab.toggle`, async () => {
				const enabled = readTabSettings().enabled
				await vscode.workspace
					.getConfiguration(TAB_SETTINGS_SECTION)
					.update("enabled", !enabled, vscode.ConfigurationTarget.Global)
				this.updateStatus(enabled ? "off" : "ok")
			}),
			vscode.commands.registerCommand(`${p}.tab.selectModel`, async () => {
				const current = readTabSettings().model
				const models = await this.fetchModels()
				const pick = await vscode.window.showQuickPick(
					models.map((id) => ({
						label: id,
						description: id === current ? "текущая" : TAB_CATALOG.includes(id) ? "каталог TKBK" : "из шлюза",
					})),
					{
						title: "Модель для Tab-автодополнения",
						placeHolder: "Быстрые модели дают лучшие подсказки: deepseek-v4.1-flash, claude-haiku-4-5",
					},
				)
				if (!pick) {
					return
				}
				await vscode.workspace
					.getConfiguration(TAB_SETTINGS_SECTION)
					.update("model", pick.label, vscode.ConfigurationTarget.Global)
				this.cache.clear()
				this.lastCompletion = undefined
				this.updateStatus("ok")
			}),
			vscode.commands.registerCommand(`${p}.tab.showLog`, () => this.output.show(true)),
			vscode.commands.registerCommand(`${p}.tab.menu`, async () => {
				const settings = readTabSettings()
				const hasKey = !!(await this.options.getApiKey())
				const items: Array<vscode.QuickPickItem & { cmd: string; args?: unknown }> = [
					{
						label: settings.enabled ? "$(circle-slash) Выключить подсказки" : "$(sparkle) Включить подсказки",
						cmd: `${p}.tab.toggle`,
					},
					{ label: `$(list-selection) Модель: ${settings.model}`, cmd: `${p}.tab.selectModel` },
					{
						label: hasKey
							? "$(key) Ключ TKBK — в настройках провайдера"
							: "$(key) Указать ключ TKBK в настройках агента",
						cmd: `${p}.settingsButtonClicked`,
					},
					{ label: "$(output) Журнал запросов", cmd: `${p}.tab.showLog` },
					{
						label: "$(settings-gear) Все настройки TKBK Tab",
						cmd: "workbench.action.openSettings",
						args: TAB_SETTINGS_SECTION,
					},
				]
				const pick = await vscode.window.showQuickPick(items, { title: "TKBK Tab — автодополнение" })
				if (pick) {
					void vscode.commands.executeCommand(pick.cmd, pick.args)
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration(TAB_SETTINGS_SECTION)) {
					this.cache.clear()
					this.lastCompletion = undefined
					this.pausedUntil = 0
					this.updateStatus("ok")
				}
			}),
		)
		void this.options.getApiKey().then((key) => this.updateStatus(key ? "ok" : "nokey"))
	}

	/** Called by the host when the saved key changes. */
	onApiKeyChanged(): void {
		this.pausedUntil = 0
		this.warnedNoKey = false
		void this.options.getApiKey().then((key) => this.updateStatus(key ? "ok" : "nokey"))
	}

	private updateStatus(state: "ok" | "nokey" | "busy" | "error" | "off"): void {
		const settings = readTabSettings()
		if (!settings.enabled || state === "off") {
			this.status.text = "$(circle-slash) TKBK Tab"
			this.status.tooltip = "Tab-автодополнение выключено. Нажмите, чтобы включить."
			this.status.backgroundColor = undefined
		} else if (state === "nokey") {
			this.status.text = "$(key) TKBK Tab"
			this.status.tooltip = "Для Tab-автодополнения нужен ключ TKBK — укажите его в настройках провайдера TKBK."
			this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
		} else if (state === "busy") {
			this.status.text = "$(loading~spin) TKBK Tab"
			this.status.tooltip = `Запрос к шлюзу TKBK (${settings.model})…`
			this.status.backgroundColor = undefined
		} else if (state === "error") {
			this.status.text = "$(warning) TKBK Tab"
			this.status.tooltip = "Шлюз TKBK не ответил. Подробности — в журнале «TKBK Tab»."
			this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
		} else {
			this.status.text = "$(sparkle) TKBK Tab"
			this.status.tooltip = `Tab-автодополнение включено · ${settings.model}. Нажмите для настроек.`
			this.status.backgroundColor = undefined
		}
	}

	private async fetchModels(): Promise<string[]> {
		const ids = new Set(TAB_CATALOG)
		const key = await this.options.getApiKey()
		if (key) {
			try {
				const res = await fetch(`${GATEWAY_BASE_URL}/models`, { headers: { authorization: `Bearer ${key}` } })
				if (res.ok) {
					const json = (await res.json()) as { data?: Array<{ id?: string }> }
					for (const m of json.data ?? []) {
						if (m?.id) {
							ids.add(m.id)
						}
					}
				}
			} catch (error) {
				this.log("models:", error instanceof Error ? error.message : String(error))
			}
		}
		return Array.from(ids)
	}

	private async requestCompletion(
		input: Parameters<typeof buildTabRequest>[0],
		timeoutMs: number,
		token: vscode.CancellationToken,
	): Promise<string> {
		const req = buildTabRequest(input)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		const sub = token.onCancellationRequested(() => controller.abort())
		try {
			const res = await fetch(req.url, {
				method: "POST",
				headers: req.headers,
				body: JSON.stringify(req.body),
				signal: controller.signal,
			})
			if (res.status === 401 || res.status === 403) {
				throw Object.assign(new Error(`auth ${res.status}`), { auth: true })
			}
			if (!res.ok) {
				throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
			}
			return extractTabText(await res.json(), req.protocol)
		} finally {
			clearTimeout(timer)
			sub.dispose()
		}
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		ctx: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[]> {
		const settings = readTabSettings()
		if (!settings.enabled || Date.now() < this.pausedUntil) {
			return []
		}
		if (!["file", "untitled", "vscode-notebook-cell", "vscode-userdata"].includes(document.uri.scheme)) {
			return []
		}
		if (settings.disabledLanguages.includes(document.languageId) || isSensitiveFile(document.fileName)) {
			return []
		}
		const line = document.lineAt(position.line)
		if (line.text.length > 2000) {
			return []
		}
		const lineBefore = line.text.slice(0, position.character)
		const lineAfter = line.text.slice(position.character)
		const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position))
		const prefix = fullPrefix.slice(-settings.contextChars)
		const endPos = document.positionAt(document.offsetAt(position) + Math.floor(settings.contextChars / 4))
		const suffix = document.getText(new vscode.Range(position, endPos))
		const multiline = allowMultiline(settings.multiline, lineBefore, lineAfter)
		const toItems = (text: string) =>
			text ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : []

		const reused = reuseFromPrevious(this.lastCompletion, prefix)
		if (reused) {
			return toItems(reused)
		}
		const key = createHash("sha1")
			.update(`${settings.model}\u0000${prefix}\u0000${suffix}${multiline ? "m" : "s"}`)
			.digest("hex")
		const cached = this.cache.get(key)
		if (cached !== undefined) {
			return toItems(cached)
		}

		if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
			const ok = await sleep(settings.debounceMs, token)
			if (!ok || token.isCancellationRequested) {
				return []
			}
		}

		const apiKey = await this.options.getApiKey()
		if (!apiKey) {
			this.updateStatus("nokey")
			if (!this.warnedNoKey) {
				this.warnedNoKey = true
				void vscode.window
					.showInformationMessage(
						"TKBK Tab: укажите ключ TKBK в настройках провайдера, чтобы включить подсказки.",
						"Открыть настройки",
						"Выключить подсказки",
					)
					.then((pick) => {
						if (pick === "Открыть настройки") {
							void vscode.commands.executeCommand(`${this.options.commandPrefix}.settingsButtonClicked`)
						}
						if (pick === "Выключить подсказки") {
							void vscode.workspace
								.getConfiguration(TAB_SETTINGS_SECTION)
								.update("enabled", false, vscode.ConfigurationTarget.Global)
						}
					})
			}
			return []
		}

		this.updateStatus("busy")
		const t0 = performance.now()
		try {
			const fileName = vscode.workspace.asRelativePath(document.uri)
			const raw = await this.requestCompletion(
				{
					baseUrl: GATEWAY_BASE_URL,
					apiKey,
					model: settings.model,
					prefix,
					suffix,
					language: document.languageId,
					fileName,
					recentEdits: this.recentEdits.format(Date.now(), fileName),
					maxTokens: multiline ? settings.maxTokens : Math.min(settings.maxTokens, 64),
					stop: tabStopSequences(multiline),
				},
				settings.timeoutMs,
				token,
			)
			const ms = Math.round(performance.now() - t0)
			if (token.isCancellationRequested) {
				this.log(`cancelled model=${settings.model} ${ms} ms ${document.languageId}`)
				return []
			}
			const text = postProcessTab(raw, { lineBefore, lineAfter, multiline, suffix, prefix })
			this.log(
				`ok model=${settings.model} ${ms} ms ${document.languageId} multiline=${multiline} raw=${raw.length} → ${text.length} chars${text ? "" : " (dropped)"}`,
			)
			this.failures = 0
			this.updateStatus("ok")
			this.cache.set(key, text)
			if (text) {
				this.lastCompletion = { prefix, text }
			}
			return toItems(text)
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				return []
			}
			this.failures++
			this.log(
				`error model=${settings.model} ${Math.round(performance.now() - t0)} ms:`,
				error instanceof Error ? error.message : String(error),
			)
			if ((error as { auth?: boolean }).auth) {
				this.updateStatus("nokey")
				this.pausedUntil = Date.now() + 60_000
			} else {
				this.updateStatus("error")
				if (this.failures >= 3) {
					this.pausedUntil = Date.now() + 30_000
					this.failures = 0
				}
			}
			return []
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose()
		}
		this.disposables.length = 0
	}
}

export function registerTabCompletion(context: vscode.ExtensionContext, options: TabCompletionOptions): TkbkTabCompletion {
	const tab = new TkbkTabCompletion(options)
	tab.register(context)
	Logger.log("[TKBK Tab] inline completions registered")
	return tab
}
