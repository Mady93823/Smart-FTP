import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as ftp from 'basic-ftp';
import { ConnectionPool } from './ConnectionPool';
import { FtpFileInfo } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';
import {
    localToRemotePath,
    remoteToLocalPath,
    normalizeRemotePath,
    isExcluded,
    remoteDir,
} from '../utils/PathUtils';

interface SyncStats {
    uploaded: number;
    downloaded: number;
    skipped: number;
    failed: number;
}

export class SyncManager {
    private readonly pool: ConnectionPool;
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    constructor(pool: ConnectionPool, configService: ConfigService, logger: Logger) {
        this.pool = pool;
        this.configService = configService;
        this.logger = logger;
    }

    public async syncWorkspace(workspaceUri: vscode.Uri): Promise<void> {
        if (this.configService.validate().length > 0) {
            vscode.window.showErrorMessage('Smart FTP: Not configured.');
            return;
        }

        const config = this.configService.getConfig();
        const workspacePath = workspaceUri.fsPath;
        const stats: SyncStats = { uploaded: 0, downloaded: 0, skipped: 0, failed: 0 };

        this.logger.separator();
        this.logger.info(`Sync: ${workspacePath} ↔ ${config.remotePath}`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Smart FTP: Syncing Workspace',
                cancellable: false,
            },
            async (progress) => {
                try {
                    const client = await this.pool.acquire();

                    progress.report({ increment: 5, message: 'Scanning remote…' });
                    const remoteFiles = new Map<string, FtpFileInfo>();
                    await this.scanRemoteDir(client, config.remotePath, remoteFiles);
                    this.logger.info(`Remote files: ${remoteFiles.size}`);

                    progress.report({ increment: 5, message: 'Scanning local…' });
                    const localFiles = new Map<string, string>(); // remotePath → localAbsPath
                    this.scanLocalDir(workspacePath, workspaceUri, config.remotePath, config.exclude, localFiles);
                    this.logger.info(`Local files:  ${localFiles.size}`);

                    const total = localFiles.size + remoteFiles.size;
                    let processed = 0;

                    // ── Upload local → remote ──────────────────────────────
                    for (const [remotePath, localAbsPath] of localFiles) {
                        processed++;
                        progress.report({
                            message: `${processed}/${total}: ${path.basename(localAbsPath)}`,
                            increment: Math.round(85 / Math.max(total, 1)),
                        });

                        const remoteInfo = remoteFiles.get(remotePath);

                        if (!remoteInfo) {
                            // Remote doesn't have it → upload
                            try {
                                await client.ensureDir(remoteDir(remotePath));
                                await client.uploadFile(localAbsPath, remotePath);
                                stats.uploaded++;
                                this.logger.info(`↑ New:    ${remotePath}`);
                            } catch (err: unknown) {
                                stats.failed++;
                                this.logger.error(`↑ Failed: ${remotePath}: ${(err as Error).message}`);
                            }
                        } else {
                            const localMtime = fs.statSync(localAbsPath).mtimeMs;
                            const remoteMtime = remoteInfo.modifiedAt?.getTime() ?? 0;

                            if (localMtime > remoteMtime + 2000) {
                                try {
                                    await client.ensureDir(remoteDir(remotePath));
                                    await client.uploadFile(localAbsPath, remotePath);
                                    stats.uploaded++;
                                    this.logger.info(`↑ Newer: ${remotePath}`);
                                } catch (err: unknown) {
                                    stats.failed++;
                                    this.logger.error(`↑ Failed: ${remotePath}: ${(err as Error).message}`);
                                }
                            } else {
                                stats.skipped++;
                                this.logger.debug(`= In sync: ${remotePath}`);
                            }

                            remoteFiles.delete(remotePath); // mark as processed
                        }
                    }

                    // ── Download remote-only files ──────────────────────────
                    for (const [remotePath, remoteInfo] of remoteFiles) {
                        processed++;
                        progress.report({ message: `↓ ${remoteInfo.name}` });

                        const localAbsPath = remoteToLocalPath(remotePath, config.remotePath, workspaceUri);
                        const localDirectory = path.dirname(localAbsPath);
                        const tempPath = `${localAbsPath}.smartftp_tmp`;

                        try {
                            if (!fs.existsSync(localDirectory)) {
                                fs.mkdirSync(localDirectory, { recursive: true });
                            }
                            await client.downloadFile(remotePath, tempPath);
                            fs.renameSync(tempPath, localAbsPath);
                            stats.downloaded++;
                            this.logger.info(`↓ Remote-only: ${remotePath}`);
                        } catch (err: unknown) {
                            if (fs.existsSync(tempPath)) { fs.unlinkSync(tempPath); }
                            stats.failed++;
                            this.logger.error(`↓ Failed: ${remotePath}: ${(err as Error).message}`);
                        }
                    }

                    const summary = `↑ ${stats.uploaded} uploaded, ↓ ${stats.downloaded} downloaded, = ${stats.skipped} in sync, ✗ ${stats.failed} failed.`;
                    this.logger.info(`Sync complete — ${summary}`);
                    progress.report({ increment: 100, message: 'Complete!' });

                    if (stats.failed === 0) {
                        vscode.window.showInformationMessage(`Smart FTP: ✓ Sync complete — ${summary}`);
                    } else {
                        vscode.window.showWarningMessage(`Smart FTP: ⚠ Sync done — ${summary}`);
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Sync failed: ${msg}`, err);
                    this.pool.invalidate();
                    vscode.window.showErrorMessage(`Smart FTP: Sync failed — ${msg}`);
                }
            }
        );
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private async scanRemoteDir(
        client: { list: (p: string) => Promise<FtpFileInfo[]> },
        remotePath: string,
        out: Map<string, FtpFileInfo>
    ): Promise<void> {
        const normalized = normalizeRemotePath(remotePath);
        let entries: FtpFileInfo[];
        try {
            entries = await client.list(normalized);
        } catch {
            this.logger.warn(`Cannot list remote directory: ${normalized}`);
            return;
        }

        for (const entry of entries) {
            const entryPath = `${normalized === '/' ? '' : normalized}/${entry.name}`;
            if (entry.type === ftp.FileType.Directory) {
                await this.scanRemoteDir(client, entryPath, out);
            } else if (entry.type === ftp.FileType.File) {
                out.set(entryPath, entry);
            }
        }
    }

    private scanLocalDir(
        rootDir: string,
        workspaceUri: vscode.Uri,
        remotePath: string,
        excludePatterns: string[],
        out: Map<string, string>
    ): void {
        this.walkLocal(rootDir, rootDir, workspaceUri, remotePath, excludePatterns, out);
    }

    private walkLocal(
        rootDir: string,
        currentDir: string,
        workspaceUri: vscode.Uri,
        remotePath: string,
        excludePatterns: string[],
        out: Map<string, string>
    ): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        const HARD_EXCLUDED = ['.git', '.vscode', 'node_modules'];

        for (const entry of entries) {
            const absPath = path.join(currentDir, entry.name);
            const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
            const topDir = relPath.split('/')[0];

            if (HARD_EXCLUDED.includes(topDir)) { continue; }
            if (isExcluded(entry.name, excludePatterns) || isExcluded(relPath, excludePatterns)) { continue; }

            if (entry.isDirectory()) {
                this.walkLocal(rootDir, absPath, workspaceUri, remotePath, excludePatterns, out);
            } else if (entry.isFile()) {
                const rPath = localToRemotePath(vscode.Uri.file(absPath), workspaceUri, remotePath);
                out.set(rPath, absPath);
            }
        }
    }
}
