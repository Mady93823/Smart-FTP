import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionPool } from './ConnectionPool';
import { isPermanentFtpError } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';
import { localToRemotePath } from '../utils/PathUtils';

export class DownloadManager {
    private readonly pool: ConnectionPool;
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    constructor(pool: ConnectionPool, configService: ConfigService, logger: Logger) {
        this.pool = pool;
        this.configService = configService;
        this.logger = logger;
    }

    /**
     * Download the remote counterpart of the open file and overwrite local copy.
     * Uses atomic temp-file → rename to avoid partial writes.
     */
    public async downloadFile(fileUri: vscode.Uri): Promise<void> {
        if (this.configService.validate().length > 0) {
            vscode.window.showErrorMessage('Smart FTP: Not configured.');
            return;
        }

        const config = this.configService.getConfig();
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('Smart FTP: File is outside the current workspace.');
            return;
        }

        const localPath = fileUri.fsPath;
        const fileName = path.basename(localPath);
        const remotePath = localToRemotePath(fileUri, workspaceFolder.uri, config.remotePath);

        this.logger.separator();
        this.logger.info(`Downloading: ${remotePath}`);
        this.logger.info(`         → ${localPath}`);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Smart FTP: Downloading ${fileName}`,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0, message: 'Connecting…' });

                const maxAttempts = config.retryCount + 1;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    const tempPath = `${localPath}.smartftp_tmp`;
                    try {
                        const client = await this.pool.acquire();
                        progress.report({ increment: 30, message: 'Downloading…' });

                        const localDir = path.dirname(localPath);
                        if (!fs.existsSync(localDir)) {
                            fs.mkdirSync(localDir, { recursive: true });
                        }

                        await client.downloadFile(remotePath, tempPath);
                        fs.renameSync(tempPath, localPath);

                        progress.report({ increment: 100, message: 'Done!' });
                        this.logger.info(`✓ Download successful: ${fileName}`);
                        vscode.window.showInformationMessage(`Smart FTP: ✓ Downloaded "${fileName}" from remote.`);
                        return;

                    } catch (err: unknown) {
                        // Clean up temp file on failure
                        if (fs.existsSync(tempPath)) { fs.unlinkSync(tempPath); }

                        const msg = err instanceof Error ? err.message : String(err);
                        this.logger.warn(`Download attempt ${attempt}/${maxAttempts} failed: ${msg}`);

                        if (isPermanentFtpError(msg)) {
                            this.logger.error(`Download failed (permanent error): ${msg}`, err);
                            vscode.window.showErrorMessage(`Smart FTP: Download failed — ${msg}`);
                            this.pool.invalidate();
                            return;
                        }

                        this.pool.invalidate();
                        if (attempt < maxAttempts) {
                            this.logger.info(`Retrying in ${config.retryDelay}ms…`);
                            await sleep(config.retryDelay);
                        } else {
                            this.logger.error(`Download failed after ${maxAttempts} attempt(s): ${msg}`, err);
                            vscode.window.showErrorMessage(`Smart FTP: Download failed for "${fileName}": ${msg}`);
                        }
                    }
                }
            }
        );
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
