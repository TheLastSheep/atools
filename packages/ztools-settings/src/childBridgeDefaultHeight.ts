import { SettingsBridgeProtocolError } from './childBridgeProtocol'

export function assertDefaultHeight(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 200) {
    throw new SettingsBridgeProtocolError()
  }
}

/** Projection defaults are not proof that a raw field was committed. */
export function createDefaultHeightReceipt() {
  let receipt: { revision: string; value: number } | undefined
  return {
    needsCommit(revision: string, confirmed: number, requested: number): boolean {
      if (requested !== confirmed) throw new SettingsBridgeProtocolError()
      return receipt?.revision !== revision || receipt.value !== requested
    },
    accept(previousRevision: string, revision: string, height: number, explicit: boolean): void {
      receipt = explicit || (receipt?.revision === previousRevision && receipt.value === height)
        ? { revision, value: height } : undefined
    },
    invalidate(): void { receipt = undefined }
  }
}
