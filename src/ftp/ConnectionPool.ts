import { FtpClient } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';

/**
 * Maintains a single persistent FTP connection that is reused across all
 * upload/download/sync operations.
 *
 * Benefits:
 *  - Only pays the connection + login cost once (or on reconnect after drop)
 *  - NOOP keepalive prevents server idle-timeout disconnects
 *  - On transient errors the pool invalidates and reconnects transparently
 */
export class ConnectionPool {
    private client: FtpClient | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private isConnecting = false;

    private static readonly KEEPALIVE_INTERVAL_MS = 30_000; // 30 s

    constructor(
        private readonly configService: ConfigService,
        private readonly logger: Logger
    ) {}

    /**
     * Acquire a ready-to-use FTP client.
     *
     * Returns the existing connection if still alive.
     * Otherwise creates a fresh connection (blocks until connected).
     */
    public async acquire(): Promise<FtpClient> {
        if (this.client && this.client.isConnected) {
            return this.client;
        }

        // Avoid concurrent reconnection attempts
        if (this.isConnecting) {
            // Wait until the in-flight connect resolves
            await this.waitForConnection();
            if (this.client && this.client.isConnected) {
                return this.client;
            }
        }

        this.isConnecting = true;
        this.stopKeepAlive();
        try {
            this.logger.info('Pool: establishing FTP connection…');
            const client = new FtpClient(this.configService, this.logger);
            await client.connect();
            this.client = client;
            this.startKeepAlive();
            this.logger.info('Pool: connection ready.');
            return client;
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Mark the current connection as broken so the next `acquire()` call
     * will create a fresh connection. Call this after any transfer error.
     */
    public invalidate(): void {
        this.stopKeepAlive();
        if (this.client) {
            this.client.disconnect().catch(() => {});
            this.client = null;
        }
        this.logger.debug('Pool: connection invalidated.');
    }

    /**
     * Gracefully close the connection and stop the keepalive timer.
     * Call during extension deactivation.
     */
    public async dispose(): Promise<void> {
        this.stopKeepAlive();
        if (this.client) {
            await this.client.disconnect();
            this.client = null;
        }
        this.logger.info('Pool: disposed.');
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private startKeepAlive(): void {
        this.keepAliveTimer = setInterval(async () => {
            if (!this.client || !this.client.isConnected) {
                this.stopKeepAlive();
                return;
            }
            try {
                await this.client.noop();
                this.logger.debug('Pool: keepalive NOOP OK');
            } catch {
                this.logger.warn('Pool: keepalive NOOP failed — connection dropped, will reconnect on next operation.');
                this.invalidate();
            }
        }, ConnectionPool.KEEPALIVE_INTERVAL_MS);
    }

    private stopKeepAlive(): void {
        if (this.keepAliveTimer !== null) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    /** Poll until `isConnecting` clears (max 60 s). */
    private waitForConnection(): Promise<void> {
        return new Promise((resolve) => {
            const start = Date.now();
            const poll = setInterval(() => {
                if (!this.isConnecting || Date.now() - start > 60_000) {
                    clearInterval(poll);
                    resolve();
                }
            }, 100);
        });
    }
}
