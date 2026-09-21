/**
 * The logging seam. Structurally satisfied by pino and bunyan with no adapter.
 *
 * There is no `info` level: this is a client, not a service, and it has nothing to announce.
 */
export interface Logger {
    debug(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
}

/** Used when no logger is supplied. Never exported - `logger` is simply optional. */
export const noopLogger: Logger = {
    debug: () => {},
    warn: () => {},
    error: () => {},
};
