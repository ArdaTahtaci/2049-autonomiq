/**
 * Hands a verified machine event to the Chainlink CRE workflow (cre/machineproof-settlement) through
 * its HTTP trigger.
 *
 * Local: `cre workflow simulate … --listen --broadcast` serves the trigger at
 * http://localhost:2000/trigger and expects `{"input": <trigger payload>}`. It answers 200 as soon as
 * the run is queued; the workflow's outcome is learned from the escrow on-chain, never from this call.
 * Deployed: the same payload goes to the CRE gateway as a JWT-signed request from one of the
 * workflow's authorizedKeys (not implemented in this MVP).
 */
export interface CreTriggerPayload {
  task_id: string;
  proof_hash: string;
}

export interface CreTrigger {
  readonly url: string;
  trigger(payload: CreTriggerPayload): Promise<void>;
}

export class CreHttpTrigger implements CreTrigger {
  constructor(
    readonly url: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async trigger(payload: CreTriggerPayload): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: payload }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`CRE trigger at ${this.url} unreachable (${reason}). Is the workflow simulator running? npm run cre:simulate`);
    }
    if (!res.ok) {
      throw new Error(`CRE trigger at ${this.url} answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}
