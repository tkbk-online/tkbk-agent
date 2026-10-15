import { afterEach, describe, expect, it } from "vitest"
import { emitProviderSettingsSaved, onProviderSettingsSaved, resetProviderSettingsListeners } from "./provider-settings-events"

describe("provider-settings-events", () => {
	afterEach(() => {
		resetProviderSettingsListeners()
	})

	it("notifies every subscriber on each save", () => {
		let first = 0
		let second = 0
		onProviderSettingsSaved(() => first++)
		onProviderSettingsSaved(() => second++)

		emitProviderSettingsSaved()
		emitProviderSettingsSaved()

		expect(first).toBe(2)
		expect(second).toBe(2)
	})

	it("stops notifying after unsubscribe", () => {
		let calls = 0
		const unsubscribe = onProviderSettingsSaved(() => calls++)

		emitProviderSettingsSaved()
		unsubscribe()
		emitProviderSettingsSaved()

		expect(calls).toBe(1)
	})

	it("keeps delivering when one listener throws", () => {
		let delivered = false
		onProviderSettingsSaved(() => {
			throw new Error("boom")
		})
		onProviderSettingsSaved(() => {
			delivered = true
		})

		expect(() => emitProviderSettingsSaved()).not.toThrow()
		expect(delivered).toBe(true)
	})
})
