import { Controller } from "@core/controller"
import { sendChatButtonClickedEvent } from "@core/controller/ui/subscribeToChatButtonClicked"
import { StateManager } from "@/core/storage/StateManager"
import { resolveApiKey } from "@/sdk/cline-session-factory"
import { Logger } from "@/shared/services/Logger"
import { ClineAPI } from "./cline"

const TKBK_PROVIDER_ID = "tkbk"

/**
 * The saved TKBK gateway key, read through the same resolver the agent uses
 * for its own requests (legacy state first, then providers.json), so the Tab
 * completion in the TKBK IDE always sees exactly the key the agent would send.
 */
export async function resolveTkbkApiKey(): Promise<string | undefined> {
	try {
		const apiKey = resolveApiKey(TKBK_PROVIDER_ID, StateManager.get().getApiConfiguration())?.trim()
		return apiKey ? apiKey : undefined
	} catch (error) {
		Logger.warn("[TKBK API] Failed to read the TKBK key:", error)
		return undefined
	}
}

export function createClineAPI(sidebarController: Controller): ClineAPI {
	const api: ClineAPI = {
		startNewTask: async (task?: string, images?: string[]) => {
			await sidebarController.clearTask()
			await sidebarController.postStateToWebview()

			await sendChatButtonClickedEvent()
			await sidebarController.initTask(task, images)
		},

		sendMessage: async (message?: string, images?: string[]) => {
			if (sidebarController.task) {
				await sidebarController.task.handleWebviewAskResponse("messageResponse", message || "", images || [])
			} else {
				Logger.error("No active task to send message to")
			}
		},

		pressPrimaryButton: async () => {
			if (sidebarController.task) {
				await sidebarController.task.handleWebviewAskResponse("yesButtonClicked", "", [])
			} else {
				Logger.error("No active task to press button for")
			}
		},

		pressSecondaryButton: async () => {
			if (sidebarController.task) {
				await sidebarController.task.handleWebviewAskResponse("noButtonClicked", "", [])
			} else {
				Logger.error("No active task to press button for")
			}
		},

		getApiKey: resolveTkbkApiKey,
	}

	return api
}
