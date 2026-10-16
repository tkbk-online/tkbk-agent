import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

export const TKBK_DEFAULT_FAST_MODEL = "deepseek-v4.1-flash"

export interface SubagentRoutingInput {
	/** `tkbk-agent.subagents.autoRouteModels` */
	autoRouteModels: boolean
	/** `tkbk-agent.subagents.fastModel` */
	fastModel: string
	/** provider of the active task (plan or act mode) */
	activeProviderId: string | undefined
}

/**
 * Decide which model the `explore` subagent role runs on. The fast model is a
 * TKBK catalog id, so it only applies while the active provider is TKBK: a
 * BYOK provider would reject it, and in that case the role inherits the
 * parent task's model (no `modelId` line in the agent file).
 */
export function pickSubagentFastModel(input: SubagentRoutingInput): string | undefined {
	if (!input.autoRouteModels) {
		return undefined
	}
	if (input.activeProviderId !== "tkbk") {
		return undefined
	}
	const model = input.fastModel.trim()
	return model ? model : undefined
}

/** Read the VS Code settings and the active provider and pick the fast model. */
export function resolveSubagentFastModel(): string | undefined {
	const settings = vscode.workspace.getConfiguration("tkbk-agent.subagents")
	let activeProviderId: string | undefined
	try {
		const api = StateManager.get().getApiConfiguration()
		activeProviderId = api.actModeApiProvider ?? api.planModeApiProvider
	} catch (error) {
		Logger.warn("[TKBK] Provider unknown while routing subagent models:", error)
	}
	return pickSubagentFastModel({
		autoRouteModels: settings.get<boolean>("autoRouteModels", true),
		fastModel: settings.get<string>("fastModel", TKBK_DEFAULT_FAST_MODEL),
		activeProviderId,
	})
}
