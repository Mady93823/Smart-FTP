import { FtpClient } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';

/**
 * Maintains a single persistent FTP connection reused across all operations.
 *
 * Key design:
 *  - `acquire()` returns the live client (connects if needed)
 *  - `withClient()` wraps an operation with a busy-lock so the NOOP keepalive
 *    never fires while a transfer is in progress (prevents concurrent-task errors)
 *  - Keepalive timer resets after each completed operation so NOOP fires 30 s
 *    after the last activity, not on a fixed wall-clock interval
 */
export class ConnectionPool {
    private client: FtpClient | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private isConnecting = false;
    private isBusy = false;             // true while a transfer is running
    private connectingWaiters: Array<() => void> = [];

    private static readonly KEEPALIVE_MS = 30_000; // 30 s idle before NOOP

    constructor(
        private readonly configService: ConfigService,
        private readonly logger: Logger
    ) {}

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Run `fn` with a live FTP client.
     *
     * Sets `isBusy = true` for the duration so the keepalive timer never
     * fires mid-transfer. On completion (or error) resets the keepalive
     * timer so it counts 30 s from the end of the last operation.
     */
    public async withClient<T>(fn: (client: FtpClient) => Promise<T>): Promise<T> {
        const client = await this.acquire();
        this.isBusy = true;
        this.stopKeepAlive(); // pause during transfer
        try {
            const result = await fn(client);
            return result;
        } catch (err: unknown) {
            // If the connection itself is broken, invalidate so next call reconnects
            const msg = err instanceof Error ? err.message : String(err);
            if (isConnectionError(msg)) {
                this.logger.warn(`Pool: connection error during operation — will reconnect. (${msg})`);
                this._invalidate();
            }
            throw err;
        } finally {
            this.isBusy = false;
            // Restart keepalive 30 s from NOW (end of last operation)
            if (this.client && this.client.isConnected) {
                this.scheduleKeepAlive();
            }
        }
    }

    /**
     * Acquire a ready-to-use FTP client.
     * Connects if no live connection exists. Waits if a connect is in flight.
     */
    public async acquire(): Promise<FtpClient> {
        if (this.client && this.client.isConnected) {
            return this.client;
        }

        if (this.isConnecting) {
            await this.waitForConnect();
            if (this.client && this.client.isConnected) { return this.client; }
        }

        this.isConnecting = true;
        this.stopKeepAlive();

        try {
            this.logger.info('Pool: establishing FTP connection…');
            const client = new FtpClient(this.configService, this.logger);
            await client.connect();
            this.client = client;
            this.logger.info('Pool: connection ready.');
            return client;
        } finally {
            this.isConnecting = false;
            // Wake any callers that were waiting
            for (const resolve of this.connectingWaiters) { resolve(); }
            this.connectingWaiters = [];
        }
    }

    /**
     * Mark the current connection as broken.
     * The next `acquire()` / `withClient()` call will reconnect.
     */
    public invalidate(): void {
        this._invalidate();
    }

    /** Gracefully close the connection. Call on extension deactivation. */
    public async dispose(): Promise<void> {
        this.stopKeepAlive();
        if (this.client) {
            await this.client.disconnect();
            this.client = null;
        }
        this.logger.info('Pool: disposed.');
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private _invalidate(): void {
        this.stopKeepAlive();
        if (this.client) {
            this.client.disconnect().catch(() => {});
            this.client = null;
        }
        this.logger.debug('Pool: connection invalidated.');
    }

    private scheduleKeepAlive(): void {
        this.stopKeepAlive();
        this.keepAliveTimer = setTimeout(async () => {
            this.keepAliveTimer = null;

            // Never send NOOP while a transfer is running
            if (this.isBusy) {
                this.logger.debug('Pool: keepalive skipped (operation in progress).');
                this.scheduleKeepAlive(); // reschedule for later
                return;
            }

            if (!this.client || !this.client.isConnected) {
                return;
            }

            try {
                await this.client.noop();
                this.logger.debug('Pool: keepalive NOOP OK — connection alive.');
                this.scheduleKeepAlive(); // arm for next cycle
            } catch {
                this.logger.warn('Pool: keepalive NOOP failed — will reconnect on next operation.');
                this._invalidate();
            }
        }, ConnectionPool.KEEPALIVE_MS);
    }

    private stopKeepAlive(): void {
        if (this.keepAliveTimer !== null) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    /** Wait until an in-flight connect attempt settles (max 60 s). */
    private waitForConnect(): Promise<void> {
        return new Promise((resolve) => {
            const timeout = setTimeout(resolve, 60_000);
            this.connectingWaiters.push(() => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
}

/**
 * Returns true for errors that indicate a broken/closed connection,
 * which should cause the pool to invalidate and reconnect.
 */
function isConnectionError(msg: string): boolean {
    return (
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EPIPE') ||
        msg.includes('socket') ||
        msg.includes('closed') ||
        msg.includes('another one is still running')
    );
}
