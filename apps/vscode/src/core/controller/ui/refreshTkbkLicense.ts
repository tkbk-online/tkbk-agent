import type { EmptyRequest } from "@shared/proto/cline/common"
import { String as ProtoString } from "@shared/proto/cline/common"
import { emptyLicenseView } from "@shared/tkbk/license"
import { TkbkLicenseService } from "@/services/tkbk/license/TkbkLicenseService"
import type { Controller } from "../index"

/**
 * TKBK: re-check the license of the saved key on tkbk.online right now (the «Проверить сейчас»
 * button of the License panel). Returns the view as JSON; the state push carries it too.
 */
export async function refreshTkbkLicense(_controller: Controller, _request: EmptyRequest): Promise<ProtoString> {
	const service = TkbkLicenseService.get()
	const view = service ? await service.refresh(true) : emptyLicenseView("unverified", "Сервис лицензий не запущен.")
	return ProtoString.create({ value: JSON.stringify(view) })
}
