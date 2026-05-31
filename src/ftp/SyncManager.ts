import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as ftp from 'basic-ftp';
import { FtpClient, FtpFileInfo } from './FtpClient';
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

/**
 * Compares local workspace files against the remote FTP directory and
 * synchronises them: newer local files are uploaded, remote-only files are
 * downloaded to local. Files that match by timestamp are skipped.
 */
export class SyncManager {
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    constructor(configService: ConfigService, logger: Logger) {
        this.configService = configService;
        this.logger = logger;
    }

    public async syncWorkspace(workspaceUri: vscode.Uri): Promise<void> {
        const validationErrors = this.configService.validate();
        if (validationErrors.length > 0) {
            vscode.window.showErrorMessage(`Smart FTP: ${validationErrors[0]}`);
            return;
        }

        const config = this.configService.getConfig();
        const workspacePath = workspaceUri.fsPath;

        this.logger.separator();
        this.logger.info('Starting workspace sync…');
        this.logger.info(`Local:  ${workspacePath}`);
        this.logger.info(`Remote: ${config.remotePath}`);

        const stats: SyncStats = { uploaded: 0, downloaded: 0, skipped: 0, failed: 0 };

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Smart FTP: Syncing Workspace',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0, message: 'Connecting…' });

                const client = new FtpClient(this.configService, this.logger);

                try {
                    await client.connect();

                    progress.report({ increment: 10, message: 'Scanning remote…' });

                    // Build a map of all remote files: remotePath → FtpFileInfo
                    const remoteFiles = new Map<string, FtpFileInfo>();
                    await this.scanRemoteDir(client, config.remotePath, remoteFiles);
                    this.logger.info(`Remote files found: ${remoteFiles.size}`);

                    progress.report({ increment: 10, message: 'Scanning local…' });

                    // Build a map of all local files: remotePath → localAbsPath
                    const localFiles = new Map<string, string>();
                    this.scanLocalDir(
                        workspacePath,
                        workspacePath,
                        workspaceUri,
                        config.remotePath,
                        config.exclude,
                        localFiles
                    );
                    this.logger.info(`Local files found:  ${localFiles.size}`);

                    const total = localFiles.size + remoteFiles.size;
                    let processed = 0;

                    // ── Upload local files that are newer than the remote ──
                    for (const [remotePath, localAbsPath] of localFiles) {
                        processed++;
                        const fileName = path.basename(localAbsPath);
                        progress.report({
                            message: `Syncing ${fileName}… (${processed}/${total})`,
                        });

                        const remoteInfo = remoteFiles.get(remotePath);

                        if (!remoteInfo) {
                            // File does not exist remotely — upload it
                            try {
                                const remoteDirectory = remoteDir(remotePath);
                                await client.ensureDir(remoteDirectory);
                                await client.uploadFile(localAbsPath, remotePath);
                                stats.uploaded++;
                                this.logger.info(`↑ Uploaded (new):    ${remotePath}`);
                            } catch (err: unknown) {
                                stats.failed++;
                                const msg = err instanceof Error ? err.message : String(err);
                                this.logger.error(`↑ Upload failed:     ${remotePath}: ${msg}`);
                            }
                        } else {
                            // Compare modification times
                            const localStat = fs.statSync(localAbsPath);
                            const localMtime = localStat.mtimeMs;
                            const remoteMtime = remoteInfo.modifiedAt?.getTime() ?? 0;

                            if (localMtime > remoteMtime + 2000) {
                                // Local is newer — upload
                                try {
                                    const remoteDirectory = remoteDir(remotePath);
                                    await client.ensureDir(remoteDirectory);
                                    await client.uploadFile(localAbsPath, remotePath);
                                    stats.uploaded++;
                                    this.logger.info(`↑ Uploaded (newer):  ${remotePath}`);
                                } catch (err: unknown) {
                                    stats.failed++;
                                    const msg = err instanceof Error ? err.message : String(err);
                                    this.logger.error(`↑ Upload failed:     ${remotePath}: ${msg}`);
                                }
                            } else {
                                stats.skipped++;
                                this.logger.debug(`= Skipped (in sync): ${remotePath}`);
                            }

                            // Mark as processed so we don't download it again
                            remoteFiles.delete(remotePath);
                        }
                    }

                    // ── Download remote-only files ──
                    for (const [remotePath, remoteInfo] of remoteFiles) {
                        processed++;
                        progress.report({
                            message: `Downloading ${remoteInfo.name}… (${processed}/${total})`,
                        });

                        const localAbsPath = remoteToLocalPath(
                            remotePath,
                            config.remotePath,
                            workspaceUri
                        );
                        const localDir = path.dirname(localAbsPath);

                        try {
                            if (!fs.existsSync(localDir)) {
                                fs.mkdirSync(localDir, { recursive: true });
                            }
                            const tempPath = `${localAbsPath}.smartftp_tmp`;
                            await client.downloadFile(remotePath, tempPath);
                            fs.renameSync(tempPath, localAbsPath);
                            stats.downloaded++;
                            this.logger.info(`↓ Downloaded (remote-only): ${remotePath}`);
                        } catch (err: unknown) {
                            stats.failed++;
                            const msg = err instanceof Error ? err.message : String(err);
                            this.logger.error(`↓ Download failed:    ${remotePath}: ${msg}`);
                        }
                    }

                    await client.disconnect();

                    const summary =
                        `Sync complete — ↑ ${stats.uploaded} uploaded, ` +
                        `↓ ${stats.downloaded} downloaded, ` +
                        `= ${stats.skipped} skipped, ` +
                        `✗ ${stats.failed} failed.`;

                    this.logger.info(summary);
                    progress.report({ increment: 100, message: 'Complete!' });

                    if (stats.failed === 0) {
                        vscode.window.showInformationMessage(`Smart FTP: ✓ ${summary}`);
                    } else {
                        vscode.window.showWarningMessage(`Smart FTP: ⚠ ${summary}`);
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Sync failed: ${msg}`, err);
                    vscode.window.showErrorMessage(`Smart FTP: Sync failed — ${msg}`);
                    await client.disconnect();
                }
            }
        );
    }

    // ────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Recursively scan the remote directory and populate `remoteFiles`.
     * Key: normalized remote path. Value: FtpFileInfo.
     */
    private async scanRemoteDir(
        client: FtpClient,
        remotePath: string,
        remoteFiles: Map<string, FtpFileInfo>
    ): Promise<void> {
        const normalized = normalizeRemotePath(remotePath);
        let entries: FtpFileInfo[];
        try {
            entries = await client.list(normalized);
        } catch {
            this.logger.warn(`Could not list remote directory: ${normalized}`);
            return;
        }

        for (const entry of entries) {
            const entryPath = `${normalized === '/' ? '' : normalized}/${entry.name}`;
            if (entry.type === ftp.FileType.Directory) {
                await this.scanRemoteDir(client, entryPath, remoteFiles);
            } else if (entry.type === ftp.FileType.File) {
                remoteFiles.set(entryPath, entry);
            }
        }
    }

    /**
     * Recursively scan the local workspace directory and populate `localFiles`.
     * Key: corresponding remote path. Value: absolute local path.
     */
    private scanLocalDir(
        rootDir: string,
        currentDir: string,
        workspaceUri: vscode.Uri,
        remotePath: string,
        excludePatterns: string[],
        localFiles: Map<string, string>
    ): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryAbsPath = path.join(currentDir, entry.name);
            const relative = path.relative(rootDir, entryAbsPath).replace(/\\/g, '/');

            if (isExcluded(entry.name, excludePatterns) || isExcluded(relative, excludePatterns)) {
                continue;
            }

            if (entry.isDirectory()) {
                this.scanLocalDir(
                    rootDir,
                    entryAbsPath,
                    workspaceUri,
                    remotePath,
                    excludePatterns,
                    localFiles
                );
            } else if (entry.isFile()) {
                const fileUri = vscode.Uri.file(entryAbsPath);
                const rPath = localToRemotePath(fileUri, workspaceUri, remotePath);
                localFiles.set(rPath, entryAbsPath);
            }
        }
    }
}
