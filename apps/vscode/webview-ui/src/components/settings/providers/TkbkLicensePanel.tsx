import { FEATURE_TITLES, TKBK_PRO_BUY_URL, type TkbkLicenseFeature, type TkbkLicenseView } from "@shared/tkbk/license"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

/**
 * «Лицензия» in the TKBK provider settings: the plan of the saved key, its end, the devices,
 * what is open on this computer, «Купить Pro» and «Проверить сейчас». The data comes with the
 * extension state (tkbkLicense); the button asks the host to re-check on tkbk.online now.
 */

const PRO_FEATURES: TkbkLicenseFeature[] = ["skills_hub", "premium_skills", "cloud_agents", "priority_support"]

const STATUS_LABEL: Record<TkbkLicenseView["status"], string> = {
	"no-key": "нет ключа",
	active: "действует",
	free: "Free",
	offline: "офлайн",
	expired: "не подтверждён",
	"device-limit": "лимит устройств",
	revoked: "отозван",
	unverified: "не проверен",
	error: "ошибка",
}

function openExternal(url: string) {
	UiServiceClient.openUrl({ value: url }).catch((err) => console.error(`Failed to open ${url}:`, err))
}

const day = (iso: string) => (iso ? iso.slice(0, 10) : "")

export function TkbkLicensePanel({ license: licenseProp }: { license?: TkbkLicenseView }) {
	const { tkbkLicense } = useExtensionState()
	const [fresh, setFresh] = useState<TkbkLicenseView | undefined>(undefined)
	const [busy, setBusy] = useState(false)
	const license = fresh ?? licenseProp ?? tkbkLicense
	if (!license) {
		return null
	}
	const paid = license.plan !== "free" && license.status !== "revoked"
	const unlocked = (f: TkbkLicenseFeature) => license.features.includes(f)

	const refresh = async () => {
		setBusy(true)
		try {
			const res = await UiServiceClient.refreshTkbkLicense({})
			if (res?.value) {
				setFresh(JSON.parse(res.value) as TkbkLicenseView)
			}
		} catch (err) {
			console.error("Failed to refresh the TKBK license:", err)
		} finally {
			setBusy(false)
		}
	}

	return (
		<section
			aria-label="Лицензия TKBK IDE"
			className="mt-3 mb-3 rounded border border-(--vscode-widget-border) p-3"
			data-testid="tkbk-license">
			<div className="flex items-center justify-between gap-2">
				<div className="text-sm font-medium">
					Лицензия: TKBK IDE {license.planTitle}
					<span className="ml-2 text-xs text-(--vscode-descriptionForeground)">{STATUS_LABEL[license.status]}</span>
				</div>
				{paid && license.until && (
					<div className="text-xs text-(--vscode-descriptionForeground)">до {day(license.until)}</div>
				)}
			</div>
			<p className="mt-1 mb-2 text-xs text-(--vscode-descriptionForeground)">{license.message}</p>
			<ul className="m-0 mb-2 list-none p-0 text-xs">
				{PRO_FEATURES.map((f) => (
					<li
						aria-label={`${FEATURE_TITLES[f]}: ${unlocked(f) ? "открыто" : "закрыто"}`}
						className="flex items-center gap-1.5"
						key={f}>
						<span aria-hidden>{unlocked(f) ? "✓" : "🔒"}</span>
						<span className={unlocked(f) ? "" : "text-(--vscode-descriptionForeground)"}>{FEATURE_TITLES[f]}</span>
					</li>
				))}
			</ul>
			<div className="mb-2 text-xs text-(--vscode-descriptionForeground)">
				Устройств на ключе: {license.devices} из {license.limits.devices}
				{license.checkedAt ? ` · проверено ${day(license.checkedAt)}` : ""}
				{license.deviceId ? ` · это устройство ${license.deviceId.slice(0, 8)}…` : ""}
			</div>
			<div className="flex flex-wrap gap-2">
				{!paid && (
					<VSCodeButton appearance="primary" onClick={() => openExternal(license.buyUrl || TKBK_PRO_BUY_URL)}>
						Купить Pro
					</VSCodeButton>
				)}
				{paid && (
					<VSCodeButton appearance="secondary" onClick={() => openExternal(license.buyUrl || TKBK_PRO_BUY_URL)}>
						Продлить
					</VSCodeButton>
				)}
				<VSCodeButton appearance="secondary" disabled={busy} onClick={() => void refresh()}>
					{busy ? "Проверяем…" : "Проверить сейчас"}
				</VSCodeButton>
			</div>
		</section>
	)
}
