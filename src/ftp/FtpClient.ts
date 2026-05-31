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
 *  - Passive-mode enforcement (basic-ftp default)
 *  - NAT / unusual PASV response handling
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

    // ── Public API ────────────────────────────────────────────────────────

    public async connect(): Promise<void> {
        const config = this.configService.getConfig();

        // Always start with a fresh socket to avoid reuse of closed connections
        this.client = this.createClient();

        this.logger.info(`Connecting to ${config.host}:${config.port} (secure=${config.secure})`);

        const accessOptions: ftp.AccessOptions = {
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            secure: config.secure ? 'implicit' : false,
            secureOptions: config.secure ? this.buildTlsOptions(config.host) : undefined,
        };

        try {
            const response = await this.client.access(accessOptions);
            // Move the verbose server greeting to DEBUG so it doesn't clutter INFO logs
            this.logger.debug(`Server greeting: ${response.message.trim()}`);
            this.logger.info('Login successful.');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Connection failed: ${msg}`, err);
            throw err;
        }
    }

    public async disconnect(): Promise<void> {
        try {
            this.client.close();
            this.logger.debug('Disconnected from FTP server.');
        } catch {
            // Already gone — ignore
        }
    }

    public get isConnected(): boolean {
        return !this.client.closed;
    }

    /** Send a NOOP command to keep the connection alive. */
    public async noop(): Promise<void> {
        await this.client.send('NOOP');
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
        this.logger.debug(`ensureDir ${normalized}`);
        try {
            await this.client.ensureDir(normalized);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`ensureDir ${normalized} failed: ${msg}`, err);
            throw err;
        }
    }

    /** Set a progress tracking callback. Call with no argument to stop. */
    public trackProgress(handler?: ProgressHandler): void {
        this.client.trackProgress(handler);
    }

    /** Upload a local file to a remote path. */
    public async uploadFile(
        localPath: string,
        remoteFilePath: string
    ): Promise<ftp.FTPResponse> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`STOR ${normalized}`);
        const response = await this.client.uploadFrom(localPath, normalized);
        this.logger.debug(`STOR response: ${response.code} ${response.message.trim()}`);
        return response;
    }

    /** Download a remote file to a local path. */
    public async downloadFile(
        remoteFilePath: string,
        localPath: string
    ): Promise<ftp.FTPResponse> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`RETR ${normalized}`);
        const response = await this.client.downloadTo(localPath, normalized);
        this.logger.debug(`RETR response: ${response.code} ${response.message.trim()}`);
        return response;
    }

    /** Delete a remote file. Silently ignores 550 (file not found). */
    public async deleteFile(remoteFilePath: string): Promise<void> {
        const normalized = normalizeRemotePath(remoteFilePath);
        this.logger.debug(`DELE ${normalized}`);
        try {
            await this.client.remove(normalized);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('550')) { throw err; }
            this.logger.debug(`File not found on remote, skipping delete: ${normalized}`);
        }
    }

    public async pwd(): Promise<string> {
        const dir = await this.client.pwd();
        this.logger.debug(`PWD: ${dir}`);
        return dir;
    }

    public async cwd(remotePath: string): Promise<void> {
        const normalized = normalizeRemotePath(remotePath);
        this.logger.debug(`CWD ${normalized}`);
        await this.client.cd(normalized);
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private createClient(): ftp.Client {
        const config = this.configService.getConfig();
        const client = new ftp.Client(config.connectionTimeout);
        client.ftp.verbose = config.debugMode;
        return client;
    }

    /**
     * Permissive TLS options — mirrors FileZilla's "Do not check certificate"
     * mode for maximum server compatibility.
     */
    private buildTlsOptions(host: string): tls.ConnectionOptions {
        return {
            host,
            rejectUnauthorized: false,
            enableTrace: false,
        };
    }
}

/**
 * Returns true for FTP error codes that are permanent and should NOT be retried.
 * 530 — Login authentication failed
 * 550 — File unavailable / permission denied
 * 500/502 — Syntax / command not implemented
 * 421 — Service not available (server shutting down)
 */
export function isPermanentFtpError(msg: string): boolean {
    return /\b(530|550|500|502|421)\b/.test(msg);
}
