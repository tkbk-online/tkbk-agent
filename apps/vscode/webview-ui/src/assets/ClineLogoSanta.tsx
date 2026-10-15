import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import ClineLogoVariable from "./ClineLogoVariable"

/**
 * Seasonal variant slot (Cline showed a Santa hat in December). TKBK Agent
 * renders the regular monogram year-round; the component stays so the home
 * header keeps its December switch without a code change.
 */
const ClineLogoSanta = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => <ClineLogoVariable {...props} />
export default ClineLogoSanta
