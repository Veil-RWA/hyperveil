// Circle's attestation service (Iris V2): the signed message a CCTP burn needs
// before its mint can be relayed on the other chain. Circle's own quickstart
// polls `GET /v2/messages/{sourceDomain}?transactionHash=` until the
// attestation is no longer "PENDING".

/**
 * The form Circle wants a transaction hash in.
 *
 * A Starknet hash is a felt, so it comes back with leading zeros stripped —
 * 0x plus 63 hex characters is normal. Circle's own Starknet quickstart
 * left-pads it to 64 before asking, and their indexer is keyed on that form.
 */
export function irisTxHash(hash: string): string {
  const bare = hash.replace(/^0x/i, "");
  return bare.length < 64 ? `0x${bare.padStart(64, "0")}` : `0x${bare}`;
}

export const IRIS_API = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
} as const;

export const CCTP_DOMAIN = { starknet: 25, hyperevm: 19 } as const;

export interface Attested {
  message: string;
  attestation: string;
}

export class IrisApi {
  constructor(private readonly baseUrl: string) {}

  /** The attested message of the burn in `txHash`, or null while pending. */
  async attestation(sourceDomain: number, txHash: string): Promise<Attested | null> {
    const res = await fetch(
      `${this.baseUrl}/v2/messages/${sourceDomain}?transactionHash=${irisTxHash(txHash)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Iris ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { messages?: Array<{ message?: string; attestation?: string }> };
    const m = data.messages?.[0];
    if (!m?.message || !m.attestation || m.attestation === "PENDING") return null;
    return { message: m.message, attestation: m.attestation };
  }
}
