import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CHECK_INTERVAL_MS, canonicalJson, OFFLINE_GRACE_MS, type TkbkLicensePayload } from "@shared/tkbk/license"
import { TkbkLicenseService } from "./TkbkLicenseService"
import { keyFingerprint, verifyLicenseSignature } from "./verify"

// The license service against a fake tkbk.online: a test key pair signs the answers the way the site does
// (Ed25519 over the canonical JSON); the cache and the device id live in a temp ~/.tkbk.
const T0 = Date.parse("2026-10-15T12:00:00Z")
const DAY = 86_400_000
const API_KEY = "cr_test_key_never_logged_0123456789" // gitleaks:allow — a made-up test value

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const PUBLIC_B64 = (() => {
	const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer
	return spki.subarray(spki.length - 32).toString("base64")
})()
const signPayload = (p: unknown, key = privateKey) => sign(null, Buffer.from(canonicalJson(p), "utf8"), key).toString("base64")

function answer(deviceId: string, now: number, over: Partial<TkbkLicensePayload> = {}): TkbkLicensePayload {
	return {
		v: 1,
		sub: "ab12cd34ef56ab12",
		plan: "pro",
		until: new Date(now + 30 * DAY).toISOString(),
		features: ["skills_hub", "premium_skills", "cloud_agents", "priority_support"],
		limits: { devices: 3, cloudAgentHours: 20, keys: 1 },
		via: "own",
		revoked: false,
		deviceId,
		deviceOk: true,
		devices: 1,
		app: "tkbk-agent",
		issuedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + CHECK_INTERVAL_MS + OFFLINE_GRACE_MS).toISOString(),
		...over,
	}
}

type Site = {
	calls: Array<Record<string, unknown>>
	mode: "ok" | "down" | "not_found" | "unavailable" | "bad_sig" | "device-limit"
}

function fakeSite(site: Site, clock: { now: number }): typeof globalThis.fetch {
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		site.calls.push(body)
		if (site.mode === "down") {
			throw new TypeError("fetch failed")
		}
		if (site.mode === "not_found") {
			return new Response(JSON.stringify({ ok: false, error: "key_not_found" }), { status: 404 })
		}
		if (site.mode === "unavailable") {
			return new Response(JSON.stringify({ ok: false, error: "license_unavailable" }), { status: 503 })
		}
		const license = answer(
			String(body.deviceId),
			clock.now,
			site.mode === "device-limit" ? { deviceOk: false, devices: 3 } : {},
		)
		const key = site.mode === "bad_sig" ? generateKeyPairSync("ed25519").privateKey : privateKey
		return new Response(JSON.stringify({ ok: true, license, signature: signPayload(license, key), publicKeyId: "test" }), {
			status: 200,
		})
	}) as typeof globalThis.fetch
}

describe("TkbkLicenseService", () => {
	let dir: string
	let clock: { now: number }
	let site: Site
	let apiKey: string
	let changes: number

	const make = () =>
		new TkbkLicenseService({
			dir,
			version: "0.1.0",
			getApiKey: () => apiKey,
			fetch: fakeSite(site, clock),
			now: () => clock.now,
			publicKey: PUBLIC_B64,
			checkUrl: "https://tkbk.test/api/license/check",
			onChange: () => {
				changes += 1
			},
		})

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "tkbk-license-"))
		clock = { now: T0 }
		site = { calls: [], mode: "ok" }
		apiKey = API_KEY
		changes = 0
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("verify: the test key pair round-trips, another key or a changed payload fails", () => {
		const p = answer("dev", T0)
		expect(verifyLicenseSignature(p, signPayload(p), PUBLIC_B64)).toBe(true)
		expect(verifyLicenseSignature({ ...p, plan: "team" }, signPayload(p), PUBLIC_B64)).toBe(false)
		expect(verifyLicenseSignature(p, signPayload(p, generateKeyPairSync("ed25519").privateKey), PUBLIC_B64)).toBe(false)
		expect(verifyLicenseSignature(p, "nope", PUBLIC_B64)).toBe(false)
		expect(keyFingerprint(API_KEY)).toHaveLength(16)
		expect(keyFingerprint("")).toBe("")
	})

	it("first run: a device id is made and kept, the check sends the key and the device, the signed answer is cached", async () => {
		const svc = make()
		await svc.load()
		expect(svc.view().status).toBe("unverified")
		const deviceId = svc.getDeviceId()
		expect(deviceId).toMatch(/^[0-9a-f]{32}$/)
		expect((await readFile(path.join(dir, "device-id"), "utf8")).trim()).toBe(deviceId)

		const view = await svc.refresh()
		expect(view.status).toBe("active")
		expect(view.plan).toBe("pro")
		expect(site.calls[0]).toEqual({ apiKey: API_KEY, deviceId, app: "tkbk-agent", version: "0.1.0" })
		expect(svc.isUnlocked("cloud_agents")).toBe(true)
		expect(changes).toBe(1)

		const cached = JSON.parse(await readFile(path.join(dir, "license.json"), "utf8"))
		expect(cached.license.plan).toBe("pro")
		expect(cached.keyFingerprint).toBe(keyFingerprint(API_KEY))
		expect(JSON.stringify(cached)).not.toContain(API_KEY)

		// a second service on the same dir trusts the cache and does not ask again within the day
		const again = make()
		await again.load()
		expect(again.getDeviceId()).toBe(deviceId)
		expect(again.view().status).toBe("active")
		clock.now = T0 + CHECK_INTERVAL_MS - 1
		await again.refresh()
		expect(site.calls).toHaveLength(1)
		clock.now = T0 + CHECK_INTERVAL_MS
		await again.refresh()
		expect(site.calls).toHaveLength(2)
	})

	it("offline: the cached plan holds for a week, then locks; the site back → active again", async () => {
		const svc = make()
		await svc.refresh()
		site.mode = "down"
		clock.now = T0 + 2 * DAY
		expect((await svc.refresh()).status).toBe("offline")
		expect(svc.isUnlocked("premium_skills")).toBe(true)
		clock.now = T0 + CHECK_INTERVAL_MS + OFFLINE_GRACE_MS + 1
		expect((await svc.refresh()).status).toBe("expired")
		expect(svc.isUnlocked("premium_skills")).toBe(false)
		site.mode = "ok"
		expect((await svc.refresh()).status).toBe("active")
	})

	it("a key the panel does not know clears the cache; a site without licenses keeps the old answer; a bad signature is ignored", async () => {
		const svc = make()
		await svc.refresh()
		site.mode = "unavailable"
		clock.now = T0 + DAY + 1
		expect((await svc.refresh()).status).toBe("offline")
		site.mode = "bad_sig"
		expect((await svc.refresh(true)).status).toBe("offline")
		expect((await svc.refresh(true)).message).toBeString()
		site.mode = "not_found"
		const v = await svc.refresh(true)
		expect(v.status).toBe("unverified")
		expect(v.message).toContain("не найден")
		expect((await readFile(path.join(dir, "license.json"), "utf8")).trim()).toBe("{}")
	})

	it("another key means a fresh check; no key means no-key and no request; the device limit locks the features", async () => {
		const svc = make()
		await svc.refresh()
		apiKey = "cr_another_key_0123456789abcdef"
		expect(svc.view().status).toBe("unverified")
		site.mode = "device-limit"
		const v = await svc.refresh()
		expect(v.status).toBe("device-limit")
		expect(v.plan).toBe("pro")
		expect(svc.isUnlocked("cloud_agents")).toBe(false)
		apiKey = ""
		expect((await svc.refresh(true)).status).toBe("no-key")
		expect(site.calls).toHaveLength(2)
	})

	it("a cache edited by hand (signature no longer matches) is dropped on load", async () => {
		const svc = make()
		await svc.refresh()
		const file = path.join(dir, "license.json")
		const cached = JSON.parse(await readFile(file, "utf8"))
		cached.license.plan = "team_plus"
		await writeFile(file, JSON.stringify(cached), "utf8")
		const tampered = make()
		await tampered.load()
		expect(tampered.view().status).toBe("unverified")
	})

	it("start() checks once and the instance registry hands the service to the state builder", async () => {
		const svc = make()
		TkbkLicenseService.set(svc)
		expect(TkbkLicenseService.get()).toBe(svc)
		svc.start()
		await new Promise((r) => setTimeout(r, 20))
		expect(site.calls).toHaveLength(1)
		svc.dispose()
		expect(TkbkLicenseService.get()).toBeUndefined()
	})
})
