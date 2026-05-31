import * as ftp from 'basic-ftp';
import { ProgressHandler } from 'basic-ftp/dist/ProgressTracker';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';
import { normalizeRemotePath } from '../utils/PathUtils';
import * as tls from 'tls';

export interface FtpFileInfo {
    name: string;
    type: ftp.FileType;
    size: number;
    modifiedAt?: Date;
}

/**
 * Wraps basic-ftp with:
 *  - Passive-mode enforcement
 *  - NAT / unusual PASV response handling
 *  - Automatic retry logic
 *  - Detailed logging of every FTP server reply
 *  - Both FTP and FTPS support
 *  - Configurable timeouts
 */
export class FtpClient {
    private client: ftp.Client;
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    constructor(configService: ConfigService, logger: Logger) {
        this.configService = configService;
        this.logger = logger;
        this.client = this.createClient();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────────────

    public async connect(): Promise<void> {
        const config = this.configService.getConfig();

        // Recreate a fresh client every time we connect so we never reuse a
        // closed/errored socket.
        this.client = this.createClient();

        this.logger.info(`Connecting to ${config.host}:${config.port} (secure=${config.secure})`);
        this.logger.debug(`Username: ${config.username}`);
        this.logger.debug(`Remote base: ${config.remotePath}`);

        const accessOptions: ftp.AccessOptions = {
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            secure: config.secure ? 'implicit' : false,
            secureOptions: config.secure
                ? this.buildTlsOptions(config.host)
                : undefined,
        };

        try {
            const response = await this.client.access(accessOptions);
            this.logger.info(`Login successful. Server: ${response.message.trim()}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Connection failed: ${msg}`, err);
            throw err;
        }
    }

    public async disconnect(): Promise<void> {
        try {
            this.client.close();
            this.logger.info('Disconnected from FTP server.');
        } catch {
            // Suppress disconnect errors — the connection may already be gone.
        }
    }

    public get isConnected(): boolean {
        return !this.client.closed;
    }

    /** List directory contents. Returns an empty array on error. */
    public async list(remotePath: string): Promise<FtpFileInfo[]> {
        const normalized = normalizeRemotePath(remotePath);
        this.logger.debug(`LIST ${normalized}`);
        try {
            const entries = await this.client.list(normalized);
            return entries.map((e) => ({
                name: e.name,
                type: e.type,
                size: e.size,
                modifiedAt: e.modifiedAt,
            }));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`LIST ${normalized} failed: ${msg}`);
            return [];
        }
    }

    /**
     * Ensure a full remote directory tree exists, creating any missing
     * intermediate directories automatically.
     */
    public async ensureDir(remoteDirPath: string): Promise<void> {
        const normalized = normalizeRemotePath(remoteDirPath);
        this.logger.debug(`Ensuring remote directory: ${normalized}`);
        try {
            await this.client.ensureDir(normalized);
            this.logger.debug(`Directory ready: ${normalized}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`ensureDir ${normalized} failed: ${msg}`, err);
            throw err;
        }
    }

    /**
     * Set a progress tracking callback. Call with no argument to stop tracking.
     */
    public trackProgress(handler?: ProgressHandler): void {
        this.client.trackProgress(handler);
    }

    /**
     * Upload a readable stream to a remote file path. Will create parent
     * directories if necessary.
     */
    public async uploadStream(
        stream: NodeJS.ReadableStream,
        remoteFilePath: string
    ): Promise<ftp.FTPResponse> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`STOR ${normalized}`);
        const response = await this.client.uploadFrom(stream as import('stream').Readable, normalized);
        this.logger.debug(`STOR response: ${response.code} ${response.message.trim()}`);
        return response;
    }

    /**
     * Upload a local file (by path) to a remote destination.
     */
    public async uploadFile(
        localPath: string,
        remoteFilePath: string
    ): Promise<ftp.FTPResponse> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`Uploading: ${localPath} → ${normalized}`);
        const response = await this.client.uploadFrom(localPath, normalized);
        this.logger.debug(`Upload response: ${response.code} ${response.message.trim()}`);
        return response;
    }

    /**
     * Download a remote file to a local file path.
     */
    public async downloadFile(
        remoteFilePath: string,
        localPath: string
    ): Promise<ftp.FTPResponse> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`Downloading: ${normalized} → ${localPath}`);
        const response = await this.client.downloadTo(localPath, normalized);
        this.logger.debug(`Download response: ${response.code} ${response.message.trim()}`);
        return response;
    }

    /**
     * Delete a remote file. Silently ignores "not found" errors.
     */
    public async deleteFile(remoteFilePath: string): Promise<void> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`DELE ${normalized}`);
        try {
            await this.client.remove(normalized);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('550')) {
                throw err;
            }
            this.logger.debug(`File not found on remote, skipping delete: ${normalized}`);
        }
    }

    /** Get the current remote working directory. */
    public async pwd(): Promise<string> {
        const dir = await this.client.pwd();
        this.logger.debug(`PWD: ${dir}`);
        return dir;
    }

    /** Change the remote working directory. */
    public async cwd(remotePath: string): Promise<void> {
        const normalized = normalizeRemotePath(remotePath);
        this.logger.debug(`CWD ${normalized}`);
        await this.client.cd(normalized);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Retry wrapper
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Execute an operation, retrying up to the configured number of times on
     * transient failures. Re-connects between attempts when needed.
     */
    public async withRetry<T>(
        operation: () => Promise<T>,
        operationName: string
    ): Promise<T> {
        const config = this.configService.getConfig();
        const maxAttempts = config.retryCount + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                if (this.client.closed) {
                    this.logger.info(`Reconnecting before attempt ${attempt}/${maxAttempts}…`);
                    await this.connect();
                }
                const result = await operation();
                if (attempt > 1) {
                    this.logger.info(`${operationName} succeeded on attempt ${attempt}.`);
                }
                return result;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.warn(
                    `${operationName} failed on attempt ${attempt}/${maxAttempts}: ${msg}`
                );

                if (attempt === maxAttempts) {
                    this.logger.error(`${operationName} failed after ${maxAttempts} attempts.`);
                    throw err;
                }

                // Close the broken connection so the next attempt gets a fresh one.
                this.client.close();
                this.logger.info(`Waiting ${config.retryDelay}ms before retry…`);
                await sleep(config.retryDelay);
            }
        }

        // TypeScript needs this even though the loop always throws or returns.
        throw new Error(`${operationName} failed after ${maxAttempts} attempts.`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ────────────────────────────────────────────────────────────────────────

    private createClient(): ftp.Client {
        const config = this.configService.getConfig();
        const client = new ftp.Client(config.connectionTimeout);

        // Wire up verbose logging for every FTP server reply
        client.ftp.verbose = config.debugMode;

        return client;
    }

    /**
     * Build permissive TLS options that tolerate self-signed certificates and
     * unusual server configurations — the same approach FileZilla uses.
     */
    private buildTlsOptions(host: string): tls.ConnectionOptions {
        return {
            host,
            // Allow self-signed / untrusted certificates (mirrors FileZilla's
            // "Do not check certificate" mode for maximum compatibility)
            rejectUnauthorized: false,
            // Do NOT request a specific session ticket so we stay compatible
            // with older TLS 1.0/1.1 servers
            enableTrace: false,
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
