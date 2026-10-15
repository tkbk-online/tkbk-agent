import type { Event } from "vscode"

export interface ClineAPI {
	/**
	 * Starts a new task with an optional initial message and images.
	 * @param task Optional initial task message.
	 * @param images Optional array of image data URIs (e.g., "data:image/webp;base64,...").
	 */
	startNewTask(task?: string, images?: string[]): Promise<void>

	/**
	 * Sends a message to the current task.
	 * @param message Optional message to send.
	 * @param images Optional array of image data URIs (e.g., "data:image/webp;base64,...").
	 */
	sendMessage(message?: string, images?: string[]): Promise<void>

	/**
	 * Simulates pressing the primary button in the chat interface.
	 */
	pressPrimaryButton(): Promise<void>

	/**
	 * Simulates pressing the secondary button in the chat interface.
	 */
	pressSecondaryButton(): Promise<void>

	/**
	 * The TKBK gateway key (`cr_…`) the person saved in TKBK Agent, or
	 * `undefined` when none is configured. Sibling extensions (e.g. the TKBK IDE
	 * Tab completion) call this instead of asking for the key a second time.
	 * The key is read on every call; callers must not cache it beyond
	 * {@link onDidChangeApiKey}.
	 */
	getApiKey(): Promise<string | undefined>

	/**
	 * Fires after provider settings were saved — including when the TKBK key is
	 * entered, replaced or cleared. Re-read with {@link getApiKey}. Present only
	 * in the VS Code host.
	 */
	onDidChangeApiKey?: Event<void>
}
