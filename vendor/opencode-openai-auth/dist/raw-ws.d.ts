import { RawWebSocket as BunRawWebSocket } from './raw-ws-bun';
import { RawWebSocket as NodeRawWebSocket } from './raw-ws-node';
export declare const RawWebSocket: typeof BunRawWebSocket | typeof NodeRawWebSocket;
