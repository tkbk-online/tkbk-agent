import { describe, expect, it } from "vitest"
import { isSubagentToolName, subagentPromptLabel } from "./message-translator"

describe("subagent tool detection", () => {
	it("recognises the generic spawn_agent and the configured roles", () => {
		expect(isSubagentToolName("spawn_agent")).toBe(true)
		expect(isSubagentToolName("subagent_explore")).toBe(true)
		expect(isSubagentToolName("subagent_review")).toBe(true)
	})

	it("leaves ordinary tools alone", () => {
		expect(isSubagentToolName("read_files")).toBe(false)
		expect(isSubagentToolName("run_commands")).toBe(false)
		expect(isSubagentToolName(undefined)).toBe(false)
	})
})

describe("subagent card label", () => {
	it("uses the task of a spawn_agent call as-is", () => {
		expect(subagentPromptLabel("spawn_agent", { systemPrompt: "x", task: "Найди роутер" })).toBe("Найди роутер")
	})

	it("prefixes a configured role and reads its prompt field", () => {
		expect(subagentPromptLabel("subagent_explore", { prompt: "Где обрабатывается вход?" })).toBe(
			"explore: Где обрабатывается вход?",
		)
		expect(subagentPromptLabel("subagent_test", JSON.stringify({ prompt: "bun test" }))).toBe("test: bun test")
	})

	it("degrades to an empty label when the input has no text yet", () => {
		expect(subagentPromptLabel("subagent_review", {})).toBe("review: ")
		expect(subagentPromptLabel("spawn_agent", undefined)).toBe("")
	})
})
