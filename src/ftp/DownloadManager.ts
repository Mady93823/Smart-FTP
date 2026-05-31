import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FtpClient } from './FtpClient';
import { ConfigService } from '../config/ConfigService';
import { Logger } from '../utils/Logger';
import { localToRemotePath } from '../utils/PathUtils';

/**
 * Manages download operations:
 *  - Download the remote counterpart of the currently open local file
 */
export class DownloadManager {
    private readonly configService: ConfigService;
    private readonly logger: Logger;

    constructor(configService: ConfigService, logger: Logger) {
        this.configService = configService;
        this.logger = logger;
    }

    /**
     * Download the remote counterpart of `fileUri` and overwrite the local
     * copy, then refresh the editor.
     */
    public async downloadFile(fileUri: vscode.Uri): Promise<void> {
        const validationErrors = this.configService.validate();
        if (validationErrors.length > 0) {
            vscode.window.showErrorMessage(`Smart FTP: ${validationErrors[0]}`);
            return;
        }

        const config = this.configService.getConfig();

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            vscode.window.showWarningMessage(
                'Smart FTP: File is outside the current workspace.'
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

        this.logger.separator();
        this.logger.info(`Downloading: ${remotePath}`);
        this.logger.info(`         → ${localPath}`);

        const client = new FtpClient(this.configService, this.logger);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Smart FTP: Downloading ${fileName}`,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 0, message: 'Connecting…' });

                try {
                    await client.withRetry(async () => {
                        await client.connect();

                        progress.report({ increment: 30, message: 'Downloading…' });

                        // Ensure the local directory exists
                        const localDir = path.dirname(localPath);
                        if (!fs.existsSync(localDir)) {
                            fs.mkdirSync(localDir, { recursive: true });
                        }

                        // Download to a temporary file first to avoid corrupting the
                        // existing local copy if the transfer fails midway.
                        const tempPath = `${localPath}.smartftp_tmp`;
                        try {
                            await client.downloadFile(remotePath, tempPath);
                        } catch (err) {
                            // Clean up the temp file on error
                            if (fs.existsSync(tempPath)) {
                                fs.unlinkSync(tempPath);
                            }
                            throw err;
                        }

                        // Atomically replace the local file
                        fs.renameSync(tempPath, localPath);

                        progress.report({ increment: 60, message: 'Done!' });
                        await client.disconnect();
                    }, `Download ${fileName}`);

                    this.logger.info(`✓ Download successful: ${fileName}`);
                    vscode.window.showInformationMessage(
                        `Smart FTP: ✓ Downloaded "${fileName}" from remote.`
                    );
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Download failed for ${fileName}: ${msg}`, err);
                    vscode.window.showErrorMessage(
                        `Smart FTP: Download failed for "${fileName}": ${msg}`
                    );
                    await client.disconnect();
                }
            }
        );
    }

    /**
     * Download a specific remote path to a given local file path.
     * Used internally by SyncManager.
     */
    public async downloadTo(
        remotePath: string,
        localPath: string
    ): Promise<void> {
        const client = new FtpClient(this.configService, this.logger);
        try {
            await client.connect();

            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }

            const tempPath = `${localPath}.smartftp_tmp`;
            try {
                await client.downloadFile(remotePath, tempPath);
                fs.renameSync(tempPath, localPath);
            } catch (err) {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
                throw err;
            }

            await client.disconnect();
            this.logger.info(`✓ Downloaded: ${remotePath} → ${localPath}`);
        } catch (err: unknown) {
            await client.disconnect();
            throw err;
        }
    }
}
