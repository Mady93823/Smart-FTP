import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FtpClient } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';
import {
    localToRemotePath,
    remoteDir,
    isExcluded,
} from '../utils/PathUtils';

/**
 * Manages all upload operations:
 *  - Upload a single file (with retry and progress)
 *  - Upload an entire workspace folder recursively
 */
export class UploadManager {
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    constructor(configService: ConfigService, logger: Logger) {
        this.configService = configService;
        this.logger = logger;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Upload a single file to the FTP server.
     * Shows a progress notification and a success/error toast.
     */
    public async uploadFile(fileUri: vscode.Uri): Promise<void> {
        const config = this.configService.getConfig();

        const validationErrors = this.configService.validate();
        if (validationErrors.length > 0) {
            const msg = `Smart FTP not configured: ${validationErrors.join(' ')}`;
            this.logger.warn(msg);
            vscode.window.showErrorMessage(`Smart FTP: ${validationErrors[0]}`);
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            this.logger.warn(`File is outside the workspace: ${fileUri.fsPath}`);
            vscode.window.showWarningMessage(
                'Smart FTP: File is outside the current workspace and cannot be uploaded.'
            );
            return;
        }

        const localPath = fileUri.fsPath;
        const fileName = path.basename(localPath);
        const remotePath = localToRemotePath(
            fileUri,
            workspaceFolder.uri,
            config.remotePath
        );
        const remoteDirectory = remoteDir(remotePath);

        this.logger.separator();
        this.logger.info(`Uploading: ${localPath}`);
        this.logger.info(`      → ${remotePath}`);

        const client = new FtpClient(this.configService, this.logger);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Smart FTP: Uploading ${fileName}`,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0, message: 'Connecting…' });

                try {
                    await client.withRetry(async () => {
                        await client.connect();

                        progress.report({ increment: 20, message: 'Creating remote directory…' });
                        await client.ensureDir(remoteDirectory);

                        progress.report({ increment: 30, message: 'Uploading file…' });

                        // Set up a transfer progress tracker
                        const stat = fs.statSync(localPath);
                        client.trackProgress((info) => {
                            if (stat.size > 0) {
                                const pct = Math.round((info.bytes / stat.size) * 50);
                                progress.report({ increment: pct, message: `${info.bytes} / ${stat.size} bytes` });
                            }
                        });

                        await client.uploadFile(localPath, remotePath);

                        client.trackProgress(); // stop tracking
                        await client.disconnect();
                    }, `Upload ${fileName}`);

                    progress.report({ increment: 100, message: 'Done!' });
                    this.logger.info(`✓ Upload successful: ${fileName}`);
                    vscode.window.showInformationMessage(
                        `Smart FTP: ✓ Uploaded ${fileName}`
                    );
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Upload failed for ${fileName}: ${msg}`, err);
                    vscode.window.showErrorMessage(
                        `Smart FTP: Upload failed for "${fileName}": ${msg}`
                    );
                    await client.disconnect();
                }
            }
        );
    }

    /**
     * Recursively upload an entire workspace folder to the FTP server.
     * Shows an overall progress notification with file counts.
     */
    public async uploadWorkspace(workspaceUri: vscode.Uri): Promise<void> {
        const validationErrors = this.configService.validate();
        if (validationErrors.length > 0) {
            vscode.window.showErrorMessage(`Smart FTP: ${validationErrors[0]}`);
            return;
        }

        const config = this.configService.getConfig();
        const workspacePath = workspaceUri.fsPath;

        this.logger.separator();
        this.logger.info(`Starting workspace upload from: ${workspacePath}`);
        this.logger.info(`Remote base: ${config.remotePath}`);

        // Collect all files to upload
        const files = this.collectFiles(workspacePath, config.exclude);
        if (files.length === 0) {
            vscode.window.showInformationMessage('Smart FTP: No files found to upload.');
            return;
        }

        this.logger.info(`Found ${files.length} file(s) to upload.`);

        const client = new FtpClient(this.configService, this.logger);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Smart FTP: Uploading Workspace',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0, message: `0 / ${files.length} files` });

                try {
                    await client.connect();

                    let uploaded = 0;
                    let failed = 0;

                    for (const localFilePath of files) {
                        const fileUri = vscode.Uri.file(localFilePath);
                        const remotePath = localToRemotePath(
                            fileUri,
                            workspaceUri,
                            config.remotePath
                        );
                        const remoteDirectory = remoteDir(remotePath);
                        const fileName = path.basename(localFilePath);

                        progress.report({
                            message: `${uploaded + 1} / ${files.length}: ${fileName}`,
                        });

                        try {
                            await client.ensureDir(remoteDirectory);
                            await client.uploadFile(localFilePath, remotePath);
                            uploaded++;
                            this.logger.info(`✓ ${remotePath}`);
                        } catch (err: unknown) {
                            failed++;
                            const msg = err instanceof Error ? err.message : String(err);
                            this.logger.error(`✗ ${remotePath}: ${msg}`);

                            // If the connection dropped, try to reconnect for the remaining files
                            if (client.isConnected === false) {
                                this.logger.info('Connection lost — attempting to reconnect…');
                                try {
                                    await client.connect();
                                } catch {
                                    this.logger.error('Reconnection failed. Aborting workspace upload.');
                                    break;
                                }
                            }
                        }

                        const pct = Math.round(((uploaded + failed) / files.length) * 100);
                        progress.report({ increment: pct });
                    }

                    await client.disconnect();

                    const summary = `Workspace upload complete: ${uploaded} succeeded, ${failed} failed.`;
                    this.logger.info(summary);

                    if (failed === 0) {
                        vscode.window.showInformationMessage(`Smart FTP: ✓ ${summary}`);
                    } else {
                        vscode.window.showWarningMessage(`Smart FTP: ⚠ ${summary} Check Output for details.`);
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Workspace upload aborted: ${msg}`, err);
                    vscode.window.showErrorMessage(
                        `Smart FTP: Workspace upload failed — ${msg}`
                    );
                    await client.disconnect();
                }
            }
        );
    }

    // ────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Recursively collect all file paths under `dir`, respecting exclusion
     * patterns. Returns absolute paths.
     */
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
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Cannot read directory ${currentDir}: ${msg}`);
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(rootDir, entryPath).replace(/\\/g, '/');

            // Check against exclusion patterns using both the name and relative path
            if (isExcluded(entry.name, excludePatterns) || isExcluded(relativePath, excludePatterns)) {
                this.logger.debug(`Excluded: ${relativePath}`);
                continue;
            }

            if (entry.isDirectory()) {
                this.walkDir(rootDir, entryPath, excludePatterns, results);
            } else if (entry.isFile()) {
                results.push(entryPath);
            }
        }
    }
}
