type BrowserExec = (file: string, args: string[], options: {
    stdio: 'ignore';
    timeout: number;
}) => unknown;
export declare function openUrl(url: string, platform?: NodeJS.Platform, execFileSync?: BrowserExec): void;
export {};
