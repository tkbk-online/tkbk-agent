import { createHash, createPublicKey, verify } from "node:crypto"
import { canonicalJson, TKBK_LICENSE_PUBLIC_KEY } from "@shared/tkbk/license"

/** DER prefix of an SPKI Ed25519 public key: the 32 raw bytes follow. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

/** True when `signature` is tkbk.online's Ed25519 signature over the canonical JSON of `payload`. Never throws. */
export function verifyLicenseSignature(
	payload: unknown,
	signature: unknown,
	publicKeyB64: string = TKBK_LICENSE_PUBLIC_KEY,
): boolean {
	try {
		if (typeof signature !== "string" || !B64.test(signature)) {
			return false
		}
		const sig = Buffer.from(signature, "base64")
		const raw = Buffer.from(publicKeyB64, "base64")
		if (sig.length !== 64 || raw.length !== 32) {
			return false
		}
		const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" })
		return verify(null, Buffer.from(canonicalJson(payload), "utf8"), key, sig)
	} catch {
		return false
	}
}

/** sha256 prefix of the key: binds the cache to the key without storing the key. */
export const keyFingerprint = (apiKey: string): string =>
	apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : ""
