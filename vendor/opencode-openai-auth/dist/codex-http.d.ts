export declare function hasWebSocketResponsesLiteMetadata(body: BodyInit | null | undefined): boolean;
export declare function sanitizeHttpFallbackBody(body: BodyInit | null | undefined): string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob | FormData | ReadableStream<any> | URLSearchParams | null | undefined;
export declare function sanitizeHttpFallbackInit(init: RequestInit | undefined): RequestInit | undefined;
