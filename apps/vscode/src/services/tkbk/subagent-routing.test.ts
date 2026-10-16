import { describe, expect, it } from "bun:test"
import { pickSubagentFastModel } from "./subagent-routing"

describe("pickSubagentFastModel", () => {
	it("routes explore to the fast TKBK model when the TKBK provider is active", () => {
		expect(pickSubagentFastModel({ autoRouteModels: true, fastModel: "glm-5.3", activeProviderId: "tkbk" })).toBe("glm-5.3")
	})

	it("keeps the parent model for BYOK providers, where a TKBK id would be unknown", () => {
		expect(
			pickSubagentFastModel({ autoRouteModels: true, fastModel: "glm-5.3", activeProviderId: "anthropic" }),
		).toBeUndefined()
		expect(
			pickSubagentFastModel({ autoRouteModels: true, fastModel: "glm-5.3", activeProviderId: undefined }),
		).toBeUndefined()
	})

	it("honours the switch and ignores an empty model", () => {
		expect(pickSubagentFastModel({ autoRouteModels: false, fastModel: "glm-5.3", activeProviderId: "tkbk" })).toBeUndefined()
		expect(pickSubagentFastModel({ autoRouteModels: true, fastModel: "   ", activeProviderId: "tkbk" })).toBeUndefined()
	})
})
