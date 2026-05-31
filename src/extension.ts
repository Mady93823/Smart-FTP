import * as vscode from 'vscode';
import { Logger } from './utils/Logger';
import { ConfigService } from './config/ConfigService';
import { FtpClient } from './ftp/FtpClient';
import { UploadManager } from './ftp/UploadManager';
import { DownloadManager } from './ftp/DownloadManager';
import { SyncManager } from './ftp/SyncManager';

let logger: Logger;
let configService: ConfigService;
let uploadManager: UploadManager;
let downloadManager: DownloadManager;
let syncManager: SyncManager;
let saveListener: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
    logger = new Logger('Smart FTP');
    configService = new ConfigService(logger);

    logger.info('Smart FTP Deploy extension activated.');

    uploadManager = new UploadManager(configService, logger);
    downloadManager = new DownloadManager(configService, logger);
    syncManager = new SyncManager(configService, logger);

    // Register all commands
    const commands: Array<[string, (...args: unknown[]) => Promise<void> | void]> = [
        ['smartFtp.uploadCurrentFile', cmdUploadCurrentFile],
        ['smartFtp.uploadWorkspace', cmdUploadWorkspace],
        ['smartFtp.downloadCurrentFile', cmdDownloadCurrentFile],
        ['smartFtp.testConnection', cmdTestConnection],
        ['smartFtp.syncWorkspace', cmdSyncWorkspace],
    ];

    for (const [id, handler] of commands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, handler)
        );
    }

    // Register auto-upload on save listener
    registerSaveListener(context);

    // Re-register save listener when configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('smartFtp')) {
                configService.reload();
                registerSaveListener(context);
                logger.info('Configuration reloaded.');
            }
        })
    );

    logger.info('All commands registered. Smart FTP Deploy is ready.');
}

function registerSaveListener(context: vscode.ExtensionContext): void {
    // Dispose existing listener before creating a new one
    if (saveListener) {
        saveListener.dispose();
        const idx = context.subscriptions.indexOf(saveListener);
        if (idx !== -1) {
            context.subscriptions.splice(idx, 1);
        }
        saveListener = undefined;
    }

    const config = configService.getConfig();
    if (config.autoUpload) {
        saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (document.uri.scheme !== 'file') {
                return;
            }
            logger.debug(`Auto-upload triggered for: ${document.fileName}`);
            await uploadManager.uploadFile(document.uri);
        });
        context.subscriptions.push(saveListener);
        logger.info('Auto-upload on save: ENABLED');
    } else {
        logger.info('Auto-upload on save: DISABLED');
    }
}

async function cmdUploadCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Smart FTP: No active file to upload.');
        return;
    }
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Smart FTP: Cannot upload a virtual/unsaved file.');
        return;
    }
    await uploadManager.uploadFile(uri);
}

async function cmdUploadWorkspace(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('Smart FTP: No workspace folder is open.');
        return;
    }
    await uploadManager.uploadWorkspace(workspaceFolders[0].uri);
}

async function cmdDownloadCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Smart FTP: No active file open to determine remote path.');
        return;
    }
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Smart FTP: Cannot determine remote path for a virtual file.');
        return;
    }
    await downloadManager.downloadFile(uri);
}

async function cmdTestConnection(): Promise<void> {
    const config = configService.getConfig();
    if (!config.host) {
        vscode.window.showErrorMessage(
            'Smart FTP: No host configured. Please set "smartFtp.host" in your settings.'
        );
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Smart FTP: Testing connection...',
            cancellable: false,
        },
        async () => {
            const client = new FtpClient(configService, logger);
            try {
                await client.connect();
                const list = await client.list('/');
                await client.disconnect();
                const msg = `Connection successful! Found ${list.length} item(s) in remote root.`;
                logger.info(msg);
                vscode.window.showInformationMessage(`Smart FTP: ${msg}`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                logger.error(`Connection test failed: ${message}`);
                vscode.window.showErrorMessage(`Smart FTP: Connection failed — ${message}`);
            }
        }
    );
}

async function cmdSyncWorkspace(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('Smart FTP: No workspace folder is open.');
        return;
    }
    await syncManager.syncWorkspace(workspaceFolders[0].uri);
}

export function deactivate(): void {
    logger?.info('Smart FTP Deploy extension deactivated.');
    if (saveListener) {
        saveListener.dispose();
    }
}
