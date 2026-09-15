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
}, options?: {
    secureDir?: boolean;
    beforeWrite?: () => void | Promise<void>;
}): Promise<string>;
export declare function sweepRpcState(root: string, activeDir: string): Promise<void>;
export declare function discoverPortFile(dir: string, expectedPid?: number): Promise<PortFileEntry | null>;
