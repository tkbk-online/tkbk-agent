/**
 * TKBK IDE / TKBK Agent license — the model shared by the extension host and the webview.
 *
 * The plan belongs to the TKBK key (cr_…): the site tkbk.online keeps it and answers
 * POST /api/license/check with a payload signed by Ed25519. The agent verifies the
 * signature with the public key embedded here, caches the answer in ~/.tkbk/license.json,
 * re-checks once a day and keeps working OFFLINE_GRACE_MS without the network.
 * Pure code: no node modules, no DOM — both sides import it.
 */

export type TkbkLicensePlan = "free" | "pro" | "team" | "team_plus"

export type TkbkLicenseFeature = "skills_hub" | "premium_skills" | "cloud_agents" | "priority_support" | "shared_budget"

export interface TkbkLicenseLimits {
	devices: number
	cloudAgentHours: number
	keys: number
}

/** Exactly what the site signs (src/lib/server/licenseCore.ts buildLicensePayload). */
export interface TkbkLicensePayload {
	v: 1
	/** a hash prefix of the key's id on the panel — the cache is bound to it, never to the key */
	sub: string
	plan: TkbkLicensePlan
	/** ISO end of the paid term, "" for Free */
	until: string
	features: TkbkLicenseFeature[]
	limits: TkbkLicenseLimits
	via: "own" | "team" | ""
	revoked: boolean
	deviceId: string
	deviceOk: boolean
	devices: number
	app: string
	issuedAt: string
	/** the answer is trusted until this moment: the agent re-checks earlier and tolerates a week offline */
	expiresAt: string
}

/** ~/.tkbk/license.json */
export interface TkbkLicenseCache {
	license: TkbkLicensePayload
	signature: string
	/** when the answer was received */
	checkedAt: string
	/** sha256 prefix of the key the answer was fetched with — a new key invalidates the cache */
	keyFingerprint: string
}

export type TkbkLicenseStatus =
	/** no TKBK key saved yet */
	| "no-key"
	/** a paid plan in force, checked recently */
	| "active"
	/** Free: no paid plan (or the paid term ended) */
	| "free"
	/** a paid plan, the last re-check failed, the cached answer still holds */
	| "offline"
	/** no network for longer than the grace: the cached answer is no longer trusted */
	| "expired"
	/** more devices than the plan allows: Pro features are locked on this computer */
	| "device-limit"
	/** the owner revoked the plan */
	| "revoked"
	/** nothing verified yet (first run, another key, a broken cache) */
	| "unverified"
	/** the site refused the key or the signature did not verify */
	| "error"

/** What the webview shows; built by the extension host from the cache and the last check. */
export interface TkbkLicenseView {
	status: TkbkLicenseStatus
	plan: TkbkLicensePlan
	planTitle: string
	/** ISO end of the term, "" for Free */
	until: string
	/** features unlocked on THIS device right now */
	features: TkbkLicenseFeature[]
	limits: TkbkLicenseLimits
	deviceOk: boolean
	devices: number
	deviceId: string
	checkedAt: string
	expiresAt: string
	/** one line for the person, in Russian */
	message: string
	buyUrl: string
}

/** Ed25519 public key of tkbk.online (raw 32 bytes, base64). The site: scripts/license-keygen.mjs --print. */
export const TKBK_LICENSE_PUBLIC_KEY = "FKebrfNcInwx1HHAW64nymm59nKFG8SqZj9O26J7qd0="
export const TKBK_LICENSE_CHECK_URL = "https://tkbk.online/api/license/check"
export const TKBK_PRO_BUY_URL = "https://tkbk.online/buy?plan=pro#ide-pro"
export const TKBK_LICENSE_APP = "tkbk-agent"

export const CHECK_INTERVAL_MS = 24 * 3_600_000
export const OFFLINE_GRACE_MS = 7 * 86_400_000
/** how often the background timer looks whether a re-check is due */
export const CHECK_TICK_MS = 3_600_000

export const PLAN_TITLES: Record<TkbkLicensePlan, string> = {
	free: "Free",
	pro: "Pro",
	team: "Teams",
	team_plus: "Teams+",
}

export const FEATURE_TITLES: Record<TkbkLicenseFeature, string> = {
	skills_hub: "Skills Hub полностью",
	premium_skills: "Премиум-скилы",
	cloud_agents: "Облачные агенты",
	priority_support: "Приоритетная поддержка",
	shared_budget: "Несколько ключей, общий бюджет",
}

const PLANS: TkbkLicensePlan[] = ["free", "pro", "team", "team_plus"]
const FEATURES: TkbkLicenseFeature[] = ["skills_hub", "premium_skills", "cloud_agents", "priority_support", "shared_budget"]

/** JSON with the keys sorted at every level and no spaces — the bytes the site signed. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
	}
	return JSON.stringify(value)
}

/** A payload with the shape the site produces (a broken cache file never crashes the agent). */
export function isLicensePayload(v: unknown): v is TkbkLicensePayload {
	if (!v || typeof v !== "object") {
		return false
	}
	const p = v as Record<string, unknown>
	return (
		p.v === 1 &&
		typeof p.sub === "string" &&
		PLANS.includes(p.plan as TkbkLicensePlan) &&
		typeof p.until === "string" &&
		Array.isArray(p.features) &&
		p.features.every((f) => FEATURES.includes(f as TkbkLicenseFeature)) &&
		!!p.limits &&
		typeof (p.limits as TkbkLicenseLimits).devices === "number" &&
		typeof p.deviceId === "string" &&
		typeof p.deviceOk === "boolean" &&
		typeof p.issuedAt === "string" &&
		typeof p.expiresAt === "string"
	)
}

const FREE_LIMITS: TkbkLicenseLimits = { devices: 3, cloudAgentHours: 0, keys: 1 }

export function emptyLicenseView(status: TkbkLicenseStatus, message: string, deviceId = ""): TkbkLicenseView {
	return {
		status,
		plan: "free",
		planTitle: PLAN_TITLES.free,
		until: "",
		features: [],
		limits: FREE_LIMITS,
		deviceOk: true,
		devices: 0,
		deviceId,
		checkedAt: "",
		expiresAt: "",
		message,
		buyUrl: TKBK_PRO_BUY_URL,
	}
}

const day = (iso: string) => iso.slice(0, 10)

/**
 * The state of the license on this computer from the cached answer alone — pure, so it is testable
 * and the same whether the network is up or not.
 *
 * @param cache the stored answer (already signature-checked when it was stored)
 * @param ctx   the current key's fingerprint and this computer's device id, the clock, the last
 *              refresh error (sets "offline" once the daily check is overdue)
 */
export function evaluateLicense(
	cache: TkbkLicenseCache | undefined,
	ctx: { keyFingerprint: string; deviceId: string; now: number; lastError?: string },
): TkbkLicenseView {
	if (!ctx.keyFingerprint) {
		return emptyLicenseView("no-key", "Сохраните ключ TKBK (cr_…), чтобы проверить план.", ctx.deviceId)
	}
	if (!cache || !isLicensePayload(cache.license)) {
		return emptyLicenseView(
			"unverified",
			ctx.lastError ? `План не проверен: ${ctx.lastError}` : "План ещё не проверен.",
			ctx.deviceId,
		)
	}
	if (cache.keyFingerprint !== ctx.keyFingerprint || cache.license.deviceId !== ctx.deviceId) {
		return emptyLicenseView("unverified", "Ключ или устройство изменились — план проверяется заново.", ctx.deviceId)
	}
	const lic = cache.license
	const base: TkbkLicenseView = {
		status: "free",
		plan: lic.plan,
		planTitle: PLAN_TITLES[lic.plan],
		until: lic.until,
		features: [],
		limits: lic.limits,
		deviceOk: lic.deviceOk,
		devices: lic.devices,
		deviceId: lic.deviceId,
		checkedAt: cache.checkedAt,
		expiresAt: lic.expiresAt,
		message: "",
		buyUrl: TKBK_PRO_BUY_URL,
	}
	const expiresAt = Date.parse(lic.expiresAt)
	if (!Number.isFinite(expiresAt) || ctx.now > expiresAt) {
		return {
			...base,
			status: "expired",
			message: "Больше недели без связи с tkbk.online — подключитесь к сети, чтобы подтвердить план.",
		}
	}
	if (lic.revoked) {
		return {
			...base,
			plan: "free",
			planTitle: PLAN_TITLES.free,
			status: "revoked",
			message: "План отозван. Напишите в поддержку TKBK.",
		}
	}
	if (lic.plan === "free") {
		return {
			...base,
			status: "free",
			message: "Free: только модели по ключу. Pro открывает Skills Hub, облачных агентов и приоритетную поддержку.",
		}
	}
	const until = Date.parse(lic.until)
	if (Number.isFinite(until) && ctx.now > until) {
		return {
			...base,
			status: "free",
			message: `Срок плана ${PLAN_TITLES[lic.plan]} закончился ${day(lic.until)}. Продлите, чтобы вернуть Pro-функции.`,
		}
	}
	if (!lic.deviceOk) {
		return {
			...base,
			status: "device-limit",
			message: `На ключе уже ${lic.devices} из ${lic.limits.devices} устройств — на этом компьютере Pro-функции закрыты. Освободите место в кабинете tkbk.online.`,
		}
	}
	const stale = ctx.lastError && Date.parse(cache.checkedAt) + CHECK_INTERVAL_MS < ctx.now
	return {
		...base,
		status: stale ? "offline" : "active",
		features: [...lic.features],
		message: stale
			? `${PLAN_TITLES[lic.plan]} до ${day(lic.until)} · нет связи с tkbk.online, план действует по кэшу до ${day(lic.expiresAt)}.`
			: `${PLAN_TITLES[lic.plan]} до ${day(lic.until)}${lic.via === "team" ? " (по команде)" : ""} · устройств ${lic.devices} из ${lic.limits.devices}.`,
	}
}

export const featureUnlocked = (view: TkbkLicenseView | undefined, feature: TkbkLicenseFeature): boolean =>
	!!view && view.features.includes(feature)

/** The text behind a lock: what is closed, why, and where Pro is bought. */
export function featureLockText(feature: TkbkLicenseFeature, view?: TkbkLicenseView): string {
	const what = FEATURE_TITLES[feature]
	const why =
		view?.status === "device-limit"
			? "на этом компьютере план не действует (лимит устройств)"
			: view?.status === "expired"
				? "план не подтверждён больше недели без сети"
				: view?.status === "revoked"
					? "план отозван"
					: view?.status === "no-key"
						? "сначала сохраните ключ TKBK"
						: "доступно в плане Pro"
	return `${what} — ${why}. Купить Pro: ${TKBK_PRO_BUY_URL}`
}

/** Should the daily check run now? (no cache, another key, or the last check older than a day) */
export function checkDue(cache: TkbkLicenseCache | undefined, keyFingerprint: string, now: number): boolean {
	if (!cache || cache.keyFingerprint !== keyFingerprint) {
		return true
	}
	const checked = Date.parse(cache.checkedAt)
	return !Number.isFinite(checked) || checked + CHECK_INTERVAL_MS <= now
}
