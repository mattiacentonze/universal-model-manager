export interface PortFileEntry {
    port: number;
    token: string;
    pid: number;
    startedAt: number;
}
export declare function writePortFile(dir: string, entry: {
    port: number;
    token: string;
    pid: number;
}): Promise<string>;
export declare function discoverPortFile(dir: string, expectedPid?: number): Promise<PortFileEntry | null>;
//# sourceMappingURL=port-file.d.ts.map