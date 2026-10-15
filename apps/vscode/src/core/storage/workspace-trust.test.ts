import { afterEach, describe, expect, it } from "bun:test"
import { isWorkspaceTrusted, setWorkspaceTrusted } from "./workspace-trust"

describe("workspace-trust", () => {
	afterEach(() => {
		setWorkspaceTrusted(true)
	})

	it("defaults to trusted for hosts without a trust concept", () => {
		expect(isWorkspaceTrusted()).toBe(true)
	})

	it("reflects the host's trust decision", () => {
		setWorkspaceTrusted(false)
		expect(isWorkspaceTrusted()).toBe(false)
		setWorkspaceTrusted(true)
		expect(isWorkspaceTrusted()).toBe(true)
	})
})
