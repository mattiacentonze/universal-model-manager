import { tmpdir } from 'node:os';
export interface RpcDirResolution {
    dir: string;
    secureDir: boolean;
    sweepRoot?: string;
}
export declare function getRpcDir(projectDirectory: string): string;
export declare function resolveRpcDir(projectDirectory: string): Promise<RpcDirResolution>;
export { tmpdir };
