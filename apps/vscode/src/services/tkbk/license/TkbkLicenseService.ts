import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
	CHECK_TICK_MS,
	checkDue,
	emptyLicenseView,
	evaluateLicense,
	featureUnlocked,
	isLicensePayload,
	TKBK_LICENSE_APP,
	TKBK_LICENSE_CHECK_URL,
	TKBK_LICENSE_PUBLIC_KEY,
	type TkbkLicenseCache,
	type TkbkLicenseFeature,
	type TkbkLicenseView,
} from "@shared/tkbk/license"
import { keyFingerprint, verifyLicenseSignature } from "./verify"

/**
 * The license of the TKBK key on this computer.
 *
 * Once a day (and on demand) it asks tkbk.online what the key may do, verifies the Ed25519
 * signature, and stores the answer in `<tkbkDir>/license.json`; a stable device id lives in
 * `<tkbkDir>/device-id`. Everything the UI needs comes from `view()`, which is pure over the
 * cache (shared/tkbk/license.ts evaluateLicense): without the network the last answer holds
 * for a week, then the Pro features lock until the next successful check.
 *
 * The key itself is read on demand from the provider settings and is never stored here.
 */

export interface TkbkLicenseServiceDeps {
	/** ~/.tkbk (resolveTkbkDir) */
	dir: string
	/** the saved TKBK key, or "" */
	getApiKey: () => string
	/** the extension version sent to the site */
	version: string
	fetch?: typeof globalThis.fetch
	now?: () => number
	/** the site's public key — tests pass their own */
	publicKey?: string
	checkUrl?: string
	/** called after every change of the view (the host pushes the state to the webview) */
	onChange?: () => void
	log?: (message: string) => void
}

const CACHE_FILE = "license.json"
const DEVICE_FILE = "device-id"
const FETCH_TIMEOUT_MS = 15_000

export class TkbkLicenseService {
	private static current: TkbkLicenseService | undefined

	/** The instance the extension host created at activation, if any. */
	static get(): TkbkLicenseService | undefined {
		return TkbkLicenseService.current
	}

	static set(instance: TkbkLicenseService | undefined): void {
		TkbkLicenseService.current = instance
	}

	private cache: TkbkLicenseCache | undefined
	private deviceId = ""
	private lastError = ""
	private loaded = false
	private inflight: Promise<TkbkLicenseView> | undefined
	private timer: ReturnType<typeof setInterval> | undefined
	private readonly fetchImpl: typeof globalThis.fetch
	private readonly now: () => number
	private readonly publicKey: string
	private readonly checkUrl: string

	constructor(private readonly deps: TkbkLicenseServiceDeps) {
		this.fetchImpl = deps.fetch ?? globalThis.fetch
		this.now = deps.now ?? Date.now
		this.publicKey = deps.publicKey ?? TKBK_LICENSE_PUBLIC_KEY
		this.checkUrl = deps.checkUrl ?? TKBK_LICENSE_CHECK_URL
	}

	/** Read the device id and the cache from disk (once). */
	async load(): Promise<void> {
		if (this.loaded) {
			return
		}
		this.loaded = true
		await mkdir(this.deps.dir, { recursive: true })
		this.deviceId = await this.readDeviceId()
		try {
			const raw = JSON.parse(await readFile(path.join(this.deps.dir, CACHE_FILE), "utf8")) as TkbkLicenseCache
			// a cache whose signature no longer verifies (edited by hand, another site key) is ignored
			if (raw && isLicensePayload(raw.license) && verifyLicenseSignature(raw.license, raw.signature, this.publicKey)) {
				this.cache = {
					license: raw.license,
					signature: raw.signature,
					checkedAt: String(raw.checkedAt ?? ""),
					keyFingerprint: String(raw.keyFingerprint ?? ""),
				}
			}
		} catch {
			this.cache = undefined
		}
	}

	private async readDeviceId(): Promise<string> {
		const file = path.join(this.deps.dir, DEVICE_FILE)
		try {
			const id = (await readFile(file, "utf8")).trim()
			if (/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
				return id
			}
		} catch {
			/* first run */
		}
		const id = randomBytes(16).toString("hex")
		await writeFile(file, `${id}\n`, "utf8")
		return id
	}

	getDeviceId(): string {
		return this.deviceId
	}

	/** The current state for the UI and the gates — pure over the cache. */
	view(): TkbkLicenseView {
		if (!this.loaded) {
			return emptyLicenseView("unverified", "План ещё не проверен.", this.deviceId)
		}
		return evaluateLicense(this.cache, {
			keyFingerprint: keyFingerprint(this.deps.getApiKey()),
			deviceId: this.deviceId,
			now: this.now(),
			lastError: this.lastError || undefined,
		})
	}

	isUnlocked(feature: TkbkLicenseFeature): boolean {
		return featureUnlocked(this.view(), feature)
	}

	/** Re-check when due (or `force`): one request at a time; the result is the new view. */
	async refresh(force = false): Promise<TkbkLicenseView> {
		await this.load()
		const apiKey = this.deps.getApiKey()
		const fp = keyFingerprint(apiKey)
		if (!fp) {
			return this.view()
		}
		if (!force && !checkDue(this.cache, fp, this.now())) {
			return this.view()
		}
		if (this.inflight) {
			return this.inflight
		}
		this.inflight = this.check(apiKey, fp).finally(() => {
			this.inflight = undefined
		})
		return this.inflight
	}

	private async check(apiKey: string, fp: string): Promise<TkbkLicenseView> {
		const before = JSON.stringify(this.view())
		try {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
			let res: Response
			try {
				res = await this.fetchImpl(this.checkUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ apiKey, deviceId: this.deviceId, app: TKBK_LICENSE_APP, version: this.deps.version }),
					signal: controller.signal,
				})
			} finally {
				clearTimeout(timeout)
			}
			const data = (await res.json().catch(() => ({}))) as {
				ok?: boolean
				error?: string
				license?: unknown
				signature?: unknown
			}
			if (!res.ok || !data.ok) {
				const code = data.error || `http_${res.status}`
				if (code === "key_not_found") {
					// the key is gone or revoked on the panel: nothing to keep
					this.cache = undefined
					await this.writeCache()
					this.lastError = "ключ не найден на панели TKBK"
				} else if (code === "license_unavailable") {
					this.lastError = "сайт пока не выдаёт лицензии"
				} else if (code === "rate") {
					this.lastError = "слишком много проверок, попробуйте позже"
				} else {
					this.lastError = `сайт ответил ${code}`
				}
				return this.view()
			}
			if (!isLicensePayload(data.license) || !verifyLicenseSignature(data.license, data.signature, this.publicKey)) {
				this.lastError = "подпись ответа не сошлась"
				return this.view()
			}
			if (data.license.deviceId !== this.deviceId) {
				this.lastError = "ответ для другого устройства"
				return this.view()
			}
			this.cache = {
				license: data.license,
				signature: data.signature as string,
				checkedAt: new Date(this.now()).toISOString(),
				keyFingerprint: fp,
			}
			this.lastError = ""
			await this.writeCache()
			return this.view()
		} catch (e) {
			this.lastError = e instanceof Error && e.name === "AbortError" ? "сайт не ответил вовремя" : "нет связи с tkbk.online"
			this.deps.log?.(`[TKBK] license check failed: ${this.lastError}`)
			return this.view()
		} finally {
			if (JSON.stringify(this.view()) !== before) {
				this.deps.onChange?.()
			}
		}
	}

	private async writeCache(): Promise<void> {
		const file = path.join(this.deps.dir, CACHE_FILE)
		try {
			await writeFile(file, this.cache ? `${JSON.stringify(this.cache, null, 2)}\n` : "{}\n", "utf8")
		} catch (e) {
			this.deps.log?.(`[TKBK] license cache not written: ${e instanceof Error ? e.message : e}`)
		}
	}

	/** Check now in the background and then once an hour look whether the daily check is due. */
	start(): void {
		void this.refresh().catch(() => undefined)
		this.timer ??= setInterval(() => void this.refresh().catch(() => undefined), CHECK_TICK_MS)
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
		if (TkbkLicenseService.current === this) {
			TkbkLicenseService.current = undefined
		}
	}
}
