export declare function rejectedUpgradeStatus(statusLine: string): number | undefined;
export declare function rejectedUpgradeEvent(buffer: Uint8Array, headerEnd: number, finalizePartial?: boolean): Record<string, unknown> | undefined;
