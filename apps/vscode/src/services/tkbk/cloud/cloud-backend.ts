import type { AgentEvent, CreateTaskRequest, Me, Task } from "./tkbkCloudAgents"

/**
 * The slice of the TKBK Cloud Agents client the background-task manager
 * needs. `TkbkCloudAgents` satisfies it structurally; tests pass a fake.
 */
export interface CloudBackend {
	me(): Promise<Me>
	createTask(req: CreateTaskRequest): Promise<{ task: Task; uploadUrl?: string }>
	events(taskId: string, opts?: { afterSeq?: number; signal?: AbortSignal }): AsyncGenerator<AgentEvent>
	diff(taskId: string): Promise<string>
	cancel(taskId: string): Promise<Task>
}

export interface CloudSettings {
	/** orchestrator base URL, default https://agents.tkbk.online */
	serverUrl: string
	/** model id sent with the task; empty = server default */
	model: string
	maxMinutes: number
}

export const DEFAULT_CLOUD_SERVER_URL = "https://agents.tkbk.online"
export const TKBK_PRO_BUY_URL = "https://tkbk.online/buy?plan=pro#ide-pro"
