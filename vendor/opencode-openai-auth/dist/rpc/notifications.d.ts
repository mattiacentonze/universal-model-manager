import type { OpenDialogPayload, RpcNotification } from './protocol';
export declare function pushNotification(payload: OpenDialogPayload, sessionId?: string): void;
export declare function drainNotifications(lastReceivedId?: number, sessionId?: string): RpcNotification[];
export declare function isTuiConnected(sessionId?: string): boolean;
export declare function resetNotificationsForTest(): void;
