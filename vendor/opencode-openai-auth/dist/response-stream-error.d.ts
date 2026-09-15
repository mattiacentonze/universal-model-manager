import { APICallError } from 'ai';
export declare class ResponseStreamError extends APICallError {
    readonly name = "ProviderResponseStreamError";
    /**
     * `retryable` defaults to true because most stream failures are transient.
     * Pass false for a failure the same request will hit again — resending then
     * only repeats the cost and the wait.
     */
    constructor(message: string, options?: ErrorOptions & {
        retryable?: boolean;
    });
}
