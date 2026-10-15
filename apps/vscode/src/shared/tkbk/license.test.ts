import { describe, expect, it } from "bun:test"
import {
	CHECK_INTERVAL_MS,
	canonicalJson,
	checkDue,
	evaluateLicense,
	featureLockText,
	featureUnlocked,
	isLicensePayload,
	OFFLINE_GRACE_MS,
	type TkbkLicenseCache,
	type TkbkLicensePayload,
} from "./license"

// The pure side of the TKBK license: what the cached, signed answer means on this computer.
const T0 = Date.parse("2026-10-15T12:00:00Z")
const DAY = 86_400_000
const FP = "0123456789abcdef"
const DEVICE = "dev-0000000000000001"

function payload(over: Partial<TkbkLicensePayload> = {}): TkbkLicensePayload {
	return {
		v: 1,
		sub: "ab12cd34ef56ab12",
		plan: "pro",
		until: new Date(T0 + 30 * DAY).toISOString(),
		features: ["skills_hub", "premium_skills", "cloud_agents", "priority_support"],
		limits: { devices: 3, cloudAgentHours: 20, keys: 1 },
		via: "own",
		revoked: false,
		deviceId: DEVICE,
		deviceOk: true,
		devices: 1,
		app: "tkbk-agent",
		issuedAt: new Date(T0).toISOString(),
		expiresAt: new Date(T0 + CHECK_INTERVAL_MS + OFFLINE_GRACE_MS).toISOString(),
		...over,
	}
}

const cache = (over: Partial<TkbkLicensePayload> = {}, checkedAt = T0): TkbkLicenseCache => ({
	license: payload(over),
	signature: "sig",
	checkedAt: new Date(checkedAt).toISOString(),
	keyFingerprint: FP,
})

const ctx = (now = T0, lastError?: string) => ({ keyFingerprint: FP, deviceId: DEVICE, now, lastError })

describe("canonicalJson", () => {
	it("sorts keys at every level, drops undefined, writes no spaces — the bytes the site signed", () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, u: undefined })).toBe(
			'{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
		)
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
	})
})

describe("evaluateLicense", () => {
	it("no key → no-key; no cache → unverified (with the last error when there is one)", () => {
		expect(evaluateLicense(undefined, { ...ctx(), keyFingerprint: "" }).status).toBe("no-key")
		expect(evaluateLicense(undefined, ctx()).status).toBe("unverified")
		expect(evaluateLicense(undefined, ctx(T0, "нет связи")).message).toContain("нет связи")
	})

	it("a Pro answer checked today: active, the features open, the message names the end and the devices", () => {
		const v = evaluateLicense(cache(), ctx(T0 + 3_600_000))
		expect(v.status).toBe("active")
		expect(v.plan).toBe("pro")
		expect(v.features).toEqual(["skills_hub", "premium_skills", "cloud_agents", "priority_support"])
		expect(v.message).toContain("Pro до 2026-11-14")
		expect(v.message).toContain("устройств 1 из 3")
		expect(featureUnlocked(v, "cloud_agents")).toBe(true)
		expect(featureUnlocked(v, "shared_budget")).toBe(false)
	})

	it("a cache of another key or another device is not trusted", () => {
		expect(evaluateLicense(cache(), { ...ctx(), keyFingerprint: "ffffffffffffffff" }).status).toBe("unverified")
		expect(evaluateLicense(cache({ deviceId: "dev-other-0000000" }), ctx()).status).toBe("unverified")
		expect(evaluateLicense({ ...cache(), license: { nope: true } as unknown as TkbkLicensePayload }, ctx()).status).toBe(
			"unverified",
		)
	})

	it("offline: the last check failed and a day passed → offline with the features kept; past the grace → expired and locked", () => {
		const offline = evaluateLicense(cache(), ctx(T0 + CHECK_INTERVAL_MS + 60_000, "нет связи с tkbk.online"))
		expect(offline.status).toBe("offline")
		expect(offline.features).toContain("cloud_agents")
		expect(offline.message).toContain("по кэшу")
		// a failed check within the day is still "active"
		expect(evaluateLicense(cache(), ctx(T0 + 60_000, "нет связи")).status).toBe("active")
		const expired = evaluateLicense(cache(), ctx(T0 + CHECK_INTERVAL_MS + OFFLINE_GRACE_MS + 1, "нет связи"))
		expect(expired.status).toBe("expired")
		expect(expired.features).toEqual([])
		expect(featureLockText("cloud_agents", expired)).toContain("без сети")
	})

	it("free, an ended term, a revoked plan and the device limit all lock the features with their own text", () => {
		const free = evaluateLicense(cache({ plan: "free", until: "", features: [], via: "" }), ctx())
		expect(free.status).toBe("free")
		expect(free.features).toEqual([])
		const ended = evaluateLicense(cache({ until: new Date(T0 - DAY).toISOString() }), ctx())
		expect(ended.status).toBe("free")
		expect(ended.message).toContain("закончился")
		const revoked = evaluateLicense(cache({ revoked: true }), ctx())
		expect(revoked.status).toBe("revoked")
		expect(revoked.plan).toBe("free")
		const limit = evaluateLicense(cache({ deviceOk: false, devices: 3 }), ctx())
		expect(limit.status).toBe("device-limit")
		expect(limit.plan).toBe("pro")
		expect(limit.features).toEqual([])
		expect(featureLockText("premium_skills", limit)).toContain("лимит устройств")
		expect(featureLockText("cloud_agents", free)).toContain("tkbk.online/buy?plan=pro")
	})

	it("a team member sees the owner's plan marked «по команде»", () => {
		const v = evaluateLicense(
			cache({
				plan: "team",
				via: "team",
				features: ["skills_hub", "premium_skills", "cloud_agents", "priority_support", "shared_budget"],
			}),
			ctx(),
		)
		expect(v.status).toBe("active")
		expect(v.planTitle).toBe("Teams")
		expect(v.message).toContain("по команде")
	})
})

describe("checkDue / isLicensePayload", () => {
	it("a check is due without a cache, for another key, or a day after the last one", () => {
		expect(checkDue(undefined, FP, T0)).toBe(true)
		expect(checkDue(cache(), "ffffffffffffffff", T0)).toBe(true)
		expect(checkDue(cache(), FP, T0 + CHECK_INTERVAL_MS - 1)).toBe(false)
		expect(checkDue(cache(), FP, T0 + CHECK_INTERVAL_MS)).toBe(true)
	})

	it("recognises the site's payload shape and nothing else", () => {
		expect(isLicensePayload(payload())).toBe(true)
		expect(isLicensePayload({ ...payload(), plan: "gold" })).toBe(false)
		expect(isLicensePayload({ ...payload(), features: ["x"] })).toBe(false)
		expect(isLicensePayload(null)).toBe(false)
		expect(isLicensePayload("{}")).toBe(false)
	})
})
