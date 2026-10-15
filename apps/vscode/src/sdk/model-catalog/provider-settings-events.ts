import { Logger } from "@shared/services/Logger"

type ProviderSettingsListener = () => void

const listeners = new Set<ProviderSettingsListener>()

/**
 * Subscribe to "providers.json was written" notifications. Host-agnostic on
 * purpose: the VS Code entry point bridges this into a `vscode.Event` for the
 * extension API (`onDidChangeApiKey`), so sibling extensions such as the TKBK
 * IDE's Tab completion can re-read the gateway key the moment it changes.
 *
 * @returns an unsubscribe function
 */
export function onProviderSettingsSaved(listener: ProviderSettingsListener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** Notify subscribers that provider settings were persisted. Listener errors never propagate. */
export function emitProviderSettingsSaved(): void {
	for (const listener of [...listeners]) {
		try {
			listener()
		} catch (error) {
			Logger.warn("[provider-settings-events] listener failed:", error)
		}
	}
}

/** Test helper: drop every subscriber. */
export function resetProviderSettingsListeners(): void {
	listeners.clear()
}
