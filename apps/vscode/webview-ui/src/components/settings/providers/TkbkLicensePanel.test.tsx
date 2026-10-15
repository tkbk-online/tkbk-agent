import type { TkbkLicenseView } from "@shared/tkbk/license"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiServiceClient } from "@/services/grpc-client"
import { TkbkLicensePanel } from "./TkbkLicensePanel"

const state: { tkbkLicense?: TkbkLicenseView } = {}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => state,
}))

vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: {
		openUrl: vi.fn(async () => ({})),
		refreshTkbkLicense: vi.fn(async () => ({ value: "" })),
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, disabled }: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
}))

const view = (over: Partial<TkbkLicenseView> = {}): TkbkLicenseView => ({
	status: "free",
	plan: "free",
	planTitle: "Free",
	until: "",
	features: [],
	limits: { devices: 3, cloudAgentHours: 0, keys: 1 },
	deviceOk: true,
	devices: 1,
	deviceId: "0123456789abcdef0123456789abcdef",
	checkedAt: "2026-10-15T12:00:00.000Z",
	expiresAt: "2026-10-23T12:00:00.000Z",
	message: "Free: только модели по ключу.",
	buyUrl: "https://tkbk.online/buy?plan=pro#ide-pro",
	...over,
})

describe("TkbkLicensePanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.tkbkLicense = undefined
	})

	it("renders nothing without a license view in the state", () => {
		const { container } = render(<TkbkLicensePanel />)
		expect(container.querySelector("[data-testid=tkbk-license]")).toBeNull()
	})

	it("Free: the locks, the devices and the «Купить Pro» button that opens the checkout", () => {
		state.tkbkLicense = view()
		render(<TkbkLicensePanel />)
		expect(screen.getByText(/Лицензия: TKBK IDE Free/)).toBeInTheDocument()
		expect(screen.getByLabelText("Облачные агенты: закрыто")).toBeInTheDocument()
		expect(screen.getByText(/Устройств на ключе: 1 из 3/)).toBeInTheDocument()
		fireEvent.click(screen.getByText("Купить Pro"))
		expect(UiServiceClient.openUrl).toHaveBeenCalledWith({ value: "https://tkbk.online/buy?plan=pro#ide-pro" })
		expect(screen.queryByText("Продлить")).toBeNull()
	})

	it("Pro: the end of the term, the open features, «Продлить», and «Проверить сейчас» asks the host and shows its answer", async () => {
		state.tkbkLicense = view({
			status: "active",
			plan: "pro",
			planTitle: "Pro",
			until: "2026-11-14T12:00:00.000Z",
			features: ["skills_hub", "premium_skills", "cloud_agents", "priority_support"],
			message: "Pro до 2026-11-14 · устройств 1 из 3.",
		})
		const refreshed = view({ status: "device-limit", plan: "pro", planTitle: "Pro", devices: 3, message: "лимит" })
		vi.mocked(UiServiceClient.refreshTkbkLicense).mockResolvedValueOnce({ value: JSON.stringify(refreshed) } as never)
		render(<TkbkLicensePanel />)
		expect(screen.getByText(/Лицензия: TKBK IDE Pro/)).toBeInTheDocument()
		expect(screen.getByText("до 2026-11-14")).toBeInTheDocument()
		expect(screen.getByLabelText("Облачные агенты: открыто")).toBeInTheDocument()
		expect(screen.getByText("Продлить")).toBeInTheDocument()
		fireEvent.click(screen.getByText("Проверить сейчас"))
		expect(UiServiceClient.refreshTkbkLicense).toHaveBeenCalledWith({})
		await waitFor(() => expect(screen.getByText(/лимит устройств/)).toBeInTheDocument())
		expect(screen.getByLabelText("Облачные агенты: закрыто")).toBeInTheDocument()
	})
})
