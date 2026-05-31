import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionPool } from './ConnectionPool';
import { isPermanentFtpError } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';
import { localToRemotePath, remoteDir, isExcluded } from '../utils/PathUtils';

// Always excluded, regardless of user config
const HARD_EXCLUDED = ['.git', '.vscode', 'node_modules'];

export class UploadManager {
    private readonly pool: ConnectionPool;
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    /** Debounce map: fsPath → pending timer */
    private readonly debounceMap = new Map<string, NodeJS.Timeout>();
    private static readonly DEBOUNCE_MS = 1500;

    constructor(pool: ConnectionPool, configService: ConfigService, logger: Logger) {
        this.pool = pool;
        this.configService = configService;
        this.logger = logger;
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Debounced upload — coalesces rapid saves of the same file into one
     * upload. Used by the auto-save listener.
     */
    public scheduleUpload(fileUri: vscode.Uri): void {
        const key = fileUri.fsPath;
        const existing = this.debounceMap.get(key);
        if (existing) { clearTimeout(existing); }

        const timer = setTimeout(() => {
            this.debounceMap.delete(key);
            this.uploadFile(fileUri).catch(() => { /* handled inside */ });
        }, UploadManager.DEBOUNCE_MS);

        this.debounceMap.set(key, timer);
    }

    /**
     * Upload a single file. Reuses the pool connection — no fresh TCP
     * handshake unless the connection was dropped.
     */
    public async uploadFile(fileUri: vscode.Uri): Promise<void> {
        const config = this.configService.getConfig();

        if (this.configService.validate().length > 0) {
            this.logger.debug('Upload skipped — not configured.');
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            this.logger.debug(`File outside workspace, skipping: ${fileUri.fsPath}`);
            return;
        }

        const localPath = fileUri.fsPath;
        const fileName = path.basename(localPath);
        const relPath = path.relative(workspaceFolder.uri.fsPath, localPath).replace(/\\/g, '/');
        const topDir = relPath.split('/')[0];

        // Hard-exclude system folders
        if (HARD_EXCLUDED.includes(topDir)) {
            this.logger.debug(`Hard-excluded: ${relPath}`);
            return;
        }
        // User-configured exclude patterns
        if (isExcluded(fileName, config.exclude) || isExcluded(relPath, config.exclude)) {
            this.logger.debug(`Excluded: ${relPath}`);
            return;
        }

        const remotePath = localToRemotePath(fileUri, workspaceFolder.uri, config.remotePath);
        const remoteDirectory = remoteDir(remotePath);

        this.logger.separator();
        this.logger.info(`Uploading: ${localPath}`);
        this.logger.info(`      → ${remotePath}`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Smart FTP: Uploading ${fileName}`,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0, message: 'Connecting…' });

                const maxAttempts = config.retryCount + 1;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        const client = await this.pool.acquire();

                        progress.report({ increment: 20, message: 'Uploading…' });

                        const stat = fs.statSync(localPath);
                        client.trackProgress((info) => {
                            if (stat.size > 0) {
                                const pct = Math.min(80, Math.round((info.bytes / stat.size) * 80));
                                progress.report({ increment: pct, message: `${formatBytes(info.bytes)} / ${formatBytes(stat.size)}` });
                            }
                        });

                        await client.ensureDir(remoteDirectory);
                        await client.uploadFile(localPath, remotePath);
                        client.trackProgress(); // stop tracking

                        progress.report({ increment: 100, message: 'Done!' });
                        this.logger.info(`✓ Upload successful: ${fileName}`);
                        vscode.window.showInformationMessage(`Smart FTP: ✓ Uploaded ${fileName}`);
                        return; // success

                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.logger.warn(`Upload attempt ${attempt}/${maxAttempts} failed: ${msg}`);

                        // Permanent errors — no point retrying
                        if (isPermanentFtpError(msg)) {
                            this.logger.error(`Upload failed (permanent error): ${msg}`, err);
                            vscode.window.showErrorMessage(`Smart FTP: Upload failed — ${msg}`);
                            this.pool.invalidate();
                            return;
                        }

                        // Invalidate pool so next acquire reconnects
                        this.pool.invalidate();

                        if (attempt < maxAttempts) {
                            this.logger.info(`Retrying in ${config.retryDelay}ms…`);
                            await sleep(config.retryDelay);
                        } else {
                            this.logger.error(`Upload failed after ${maxAttempts} attempt(s): ${msg}`, err);
                            vscode.window.showErrorMessage(`Smart FTP: Upload failed for "${fileName}": ${msg}`);
                        }
                    }
                }
            }
        );
    }

    /**
     * Recursively upload the entire workspace using the pool connection.
     */
    public async uploadWorkspace(workspaceUri: vscode.Uri): Promise<void> {
        if (this.configService.validate().length > 0) {
            vscode.window.showErrorMessage('Smart FTP: Not configured.');
            return;
        }

        const config = this.configService.getConfig();
        const workspacePath = workspaceUri.fsPath;

        this.logger.separator();
        this.logger.info(`Workspace upload: ${workspacePath} → ${config.remotePath}`);

        const files = this.collectFiles(workspacePath, config.exclude);
        if (files.length === 0) {
            vscode.window.showInformationMessage('Smart FTP: No files found to upload.');
            return;
        }
        this.logger.info(`Found ${files.length} file(s).`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Smart FTP: Uploading Workspace',
                cancellable: false,
            },
            async (progress) => {
                let uploaded = 0;
                let failed = 0;

                try {
                    // Acquire once — reuse for all files
                    const client = await this.pool.acquire();

                    for (const localFilePath of files) {
                        const fileUri = vscode.Uri.file(localFilePath);
                        const remotePath = localToRemotePath(fileUri, workspaceUri, config.remotePath);
                        const fileName = path.basename(localFilePath);

                        progress.report({
                            message: `${uploaded + failed + 1}/${files.length}: ${fileName}`,
                            increment: Math.round(100 / files.length),
                        });

                        try {
                            await client.ensureDir(remoteDir(remotePath));
                            await client.uploadFile(localFilePath, remotePath);
                            uploaded++;
                            this.logger.info(`✓ ${remotePath}`);
                        } catch (err: unknown) {
                            failed++;
                            const msg = err instanceof Error ? err.message : String(err);
                            this.logger.error(`✗ ${remotePath}: ${msg}`);

                            if (!client.isConnected) {
                                this.pool.invalidate();
                                try {
                                    await this.pool.acquire();
                                } catch {
                                    this.logger.error('Reconnection failed — aborting workspace upload.');
                                    break;
                                }
                            }
                        }
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Workspace upload aborted: ${msg}`, err);
                    vscode.window.showErrorMessage(`Smart FTP: Workspace upload failed — ${msg}`);
                    return;
                }

                const summary = `${uploaded} uploaded, ${failed} failed.`;
                this.logger.info(`Workspace upload complete: ${summary}`);
                if (failed === 0) {
                    vscode.window.showInformationMessage(`Smart FTP: ✓ Workspace upload complete — ${summary}`);
                } else {
                    vscode.window.showWarningMessage(`Smart FTP: ⚠ Workspace upload done — ${summary} Check Output for details.`);
                }
            }
        );
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private collectFiles(dir: string, excludePatterns: string[]): string[] {
        const results: string[] = [];
        this.walkDir(dir, dir, excludePatterns, results);
        return results;
    }

    private walkDir(
        rootDir: string,
        currentDir: string,
        excludePatterns: string[],
        results: string[]
    ): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relPath = path.relative(rootDir, entryPath).replace(/\\/g, '/');
            const topDir = relPath.split('/')[0];

            if (HARD_EXCLUDED.includes(topDir)) { continue; }
            if (isExcluded(entry.name, excludePatterns) || isExcluded(relPath, excludePatterns)) { continue; }

            if (entry.isDirectory()) {
                this.walkDir(rootDir, entryPath, excludePatterns, results);
            } else if (entry.isFile()) {
                results.push(entryPath);
            }
        }
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
