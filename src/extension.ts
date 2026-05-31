import * as vscode from 'vscode';
import { Logger } from './utils/Logger';
import { ConfigService } from './config/ConfigService';
import { ConnectionPool } from './ftp/ConnectionPool';
import { FtpClient } from './ftp/FtpClient';
import { UploadManager } from './ftp/UploadManager';
import { DownloadManager } from './ftp/DownloadManager';
import { SyncManager } from './ftp/SyncManager';

let logger: Logger;
let configService: ConfigService;
let pool: ConnectionPool;
let uploadManager: UploadManager;
let downloadManager: DownloadManager;
let syncManager: SyncManager;
let saveListener: vscode.Disposable | undefined;
let statusBarItem: vscode.StatusBarItem;
let configuringInProgress = false;

export function activate(context: vscode.ExtensionContext): void {
    logger = new Logger('Smart FTP');
    configService = new ConfigService(logger);

    logger.info('Smart FTP Deploy extension activated.');

    // One shared persistent connection for all operations
    pool = new ConnectionPool(configService, logger);
    uploadManager = new UploadManager(pool, configService, logger);
    downloadManager = new DownloadManager(pool, configService, logger);
    syncManager = new SyncManager(pool, configService, logger);

    // ── Status bar ────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'smartFtp.toggleAutoUpload';
    context.subscriptions.push(statusBarItem);
    updateStatusBar();
    statusBarItem.show();

    // ── Register commands ─────────────────────────────────────────────────
    const commands: Array<[string, (...args: unknown[]) => Promise<void> | void]> = [
        ['smartFtp.uploadCurrentFile',   cmdUploadCurrentFile],
        ['smartFtp.uploadWorkspace',     cmdUploadWorkspace],
        ['smartFtp.downloadCurrentFile', cmdDownloadCurrentFile],
        ['smartFtp.testConnection',      cmdTestConnection],
        ['smartFtp.syncWorkspace',       cmdSyncWorkspace],
        ['smartFtp.configure',           cmdConfigure],
        ['smartFtp.toggleAutoUpload',    cmdToggleAutoUpload],
    ];
    for (const [id, handler] of commands) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    // ── Auto-upload on save ───────────────────────────────────────────────
    registerSaveListener(context);

    // ── React to settings changes ─────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('smartFtp')) {
                configService.reload();
                // Reset the pool so it reconnects with new credentials
                pool.invalidate();
                registerSaveListener(context);
                updateStatusBar();
                logger.info('Configuration reloaded.');
            }
        })
    );

    // Prompt to configure if not yet set up
    if (!configService.isConfigured()) {
        vscode.window.showInformationMessage(
            'Smart FTP: Not configured yet.',
            'Configure Now'
        ).then((choice) => {
            if (choice === 'Configure Now') {
                vscode.commands.executeCommand('smartFtp.configure');
            }
        });
    }

    logger.info('All commands registered. Smart FTP Deploy is ready.');
}

// ── Status bar ────────────────────────────────────────────────────────────────

function updateStatusBar(): void {
    const config = configService.getConfig();
    const host = config.host || 'Not configured';
    if (config.autoUpload) {
        statusBarItem.text = '$(cloud-upload) FTP: Auto';
        statusBarItem.tooltip = `Smart FTP: Auto-upload ON — ${host}\nClick to disable`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(circle-slash) FTP: Off';
        statusBarItem.tooltip = `Smart FTP: Auto-upload OFF — ${host}\nClick to enable`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

// ── Save listener ─────────────────────────────────────────────────────────────

function registerSaveListener(context: vscode.ExtensionContext): void {
    if (saveListener) {
        saveListener.dispose();
        const idx = context.subscriptions.indexOf(saveListener);
        if (idx !== -1) { context.subscriptions.splice(idx, 1); }
        saveListener = undefined;
    }

    const config = configService.getConfig();
    if (config.autoUpload) {
        saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme !== 'file') { return; }
            if (!configService.isConfigured()) { return; }
            if (configuringInProgress) { return; }
            // Debounced — prevents duplicate uploads from rapid settings saves
            uploadManager.scheduleUpload(document.uri);
        });
        context.subscriptions.push(saveListener);
        logger.info('Auto-upload on save: ENABLED');
    } else {
        logger.info('Auto-upload on save: DISABLED');
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdConfigure(): Promise<void> {
    configuringInProgress = true;
    logger.info('Opening configuration wizard…');
    logger.show();

    const current = configService.getConfig();

    const host = await vscode.window.showInputBox({
        title: 'Smart FTP — Step 1 of 6: FTP Host',
        prompt: 'Enter your FTP server hostname or IP address',
        value: current.host,
        placeHolder: 'e.g. ftp.example.com or 192.168.1.1',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'Host cannot be empty',
    });
    if (host === undefined) { configuringInProgress = false; return; }

    const portStr = await vscode.window.showInputBox({
        title: 'Smart FTP — Step 2 of 6: Port',
        prompt: 'FTP port (21 for FTP, 990 for implicit FTPS)',
        value: String(current.port),
        placeHolder: '21',
        ignoreFocusOut: true,
        validateInput: (v) => {
            const n = parseInt(v, 10);
            return (!isNaN(n) && n >= 1 && n <= 65535) ? undefined : 'Enter a valid port (1–65535)';
        },
    });
    if (portStr === undefined) { configuringInProgress = false; return; }

    const username = await vscode.window.showInputBox({
        title: 'Smart FTP — Step 3 of 6: Username',
        prompt: 'FTP login username',
        value: current.username,
        placeHolder: 'e.g. admin',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'Username cannot be empty',
    });
    if (username === undefined) { configuringInProgress = false; return; }

    const password = await vscode.window.showInputBox({
        title: 'Smart FTP — Step 4 of 6: Password',
        prompt: 'FTP password (stored in VS Code workspace settings)',
        value: current.password,
        password: true,
        ignoreFocusOut: true,
    });
    if (password === undefined) { configuringInProgress = false; return; }

    const remotePath = await vscode.window.showInputBox({
        title: 'Smart FTP — Step 5 of 6: Remote Base Path',
        prompt: 'The remote directory to deploy into (use / for root)',
        value: current.remotePath,
        placeHolder: '/public_html',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'Path cannot be empty',
    });
    if (remotePath === undefined) { configuringInProgress = false; return; }

    const secureChoice = await vscode.window.showQuickPick(
        [
            { label: '$(lock) FTP — plain (port 21)', value: false },
            { label: '$(shield) FTPS — FTP over TLS (port 990)', value: true },
        ],
        {
            title: 'Smart FTP — Step 6 of 6: Security',
            placeHolder: 'Choose connection type',
            ignoreFocusOut: true,
        }
    );
    if (secureChoice === undefined) { configuringInProgress = false; return; }

    const autoChoice = await vscode.window.showQuickPick(
        [
            { label: '$(cloud-upload) Yes — upload automatically on every save', value: true },
            { label: '$(circle-slash) No — upload manually only', value: false },
        ],
        {
            title: 'Smart FTP — Auto Upload on Save',
            placeHolder: 'Enable auto-upload when you save a file?',
            ignoreFocusOut: true,
        }
    );
    if (autoChoice === undefined) { configuringInProgress = false; return; }

    // Save all settings
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Smart FTP: Saving configuration…', cancellable: false },
        async () => {
            await configService.saveSetting('host', host.trim());
            await configService.saveSetting('port', parseInt(portStr, 10));
            await configService.saveSetting('username', username.trim());
            await configService.saveSetting('password', password);
            await configService.saveSetting('remotePath', remotePath.trim());
            await configService.saveSetting('secure', secureChoice.value);
            await configService.saveSetting('autoUpload', autoChoice.value);
        }
    );

    configService.reload();
    pool.invalidate(); // force reconnect with new credentials
    updateStatusBar();
    configuringInProgress = false;

    logger.info(`Configuration saved — host: ${host.trim()}, user: ${username.trim()}, remote: ${remotePath.trim()}`);

    const action = await vscode.window.showInformationMessage(
        `Smart FTP: ✓ Configuration saved for ${host.trim()}`,
        'Test Connection'
    );
    if (action === 'Test Connection') {
        await cmdTestConnection();
    }
}

async function cmdToggleAutoUpload(): Promise<void> {
    const newValue = !configService.getConfig().autoUpload;
    await configService.saveSetting('autoUpload', newValue);
    configService.reload();
    vscode.window.showInformationMessage(
        `Smart FTP: Auto-upload on save ${newValue ? 'ENABLED ✓' : 'DISABLED ✗'}`
    );
    logger.info(`Auto-upload toggled: ${newValue ? 'ON' : 'OFF'}`);
}

async function cmdUploadCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Smart FTP: No active file to upload.'); return; }
    if (editor.document.uri.scheme !== 'file') { vscode.window.showWarningMessage('Smart FTP: Cannot upload a virtual/unsaved file.'); return; }
    if (!configService.isConfigured()) {
        const c = await vscode.window.showErrorMessage('Smart FTP: Not configured.', 'Configure Now');
        if (c === 'Configure Now') { await cmdConfigure(); }
        return;
    }
    await uploadManager.uploadFile(editor.document.uri);
}

async function cmdUploadWorkspace(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) { vscode.window.showWarningMessage('Smart FTP: No workspace folder is open.'); return; }
    if (!configService.isConfigured()) {
        const c = await vscode.window.showErrorMessage('Smart FTP: Not configured.', 'Configure Now');
        if (c === 'Configure Now') { await cmdConfigure(); }
        return;
    }
    await uploadManager.uploadWorkspace(vscode.workspace.workspaceFolders[0].uri);
}

async function cmdDownloadCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Smart FTP: No active file open.'); return; }
    if (editor.document.uri.scheme !== 'file') { vscode.window.showWarningMessage('Smart FTP: Cannot download to a virtual file.'); return; }
    if (!configService.isConfigured()) {
        const c = await vscode.window.showErrorMessage('Smart FTP: Not configured.', 'Configure Now');
        if (c === 'Configure Now') { await cmdConfigure(); }
        return;
    }
    await downloadManager.downloadFile(editor.document.uri);
}

async function cmdTestConnection(): Promise<void> {
    const config = configService.getConfig();
    if (!config.host) {
        const c = await vscode.window.showErrorMessage('Smart FTP: No host configured.', 'Configure Now');
        if (c === 'Configure Now') { await cmdConfigure(); }
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Smart FTP: Testing connection…', cancellable: false },
        async () => {
            // Use a fresh dedicated client for the test (don't disturb the pool)
            const client = new FtpClient(configService, logger);
            try {
                await client.connect();
                const list = await client.list('/');
                await client.disconnect();
                const msg = `Connection successful! Found ${list.length} item(s) in remote root.`;
                logger.info(msg);
                vscode.window.showInformationMessage(`Smart FTP: ✓ ${msg}`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                logger.error(`Connection test failed: ${message}`);
                vscode.window.showErrorMessage(`Smart FTP: Connection failed — ${message}`);
            }
        }
    );
}

async function cmdSyncWorkspace(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) { vscode.window.showWarningMessage('Smart FTP: No workspace folder is open.'); return; }
    if (!configService.isConfigured()) {
        const c = await vscode.window.showErrorMessage('Smart FTP: Not configured.', 'Configure Now');
        if (c === 'Configure Now') { await cmdConfigure(); }
        return;
    }
    await syncManager.syncWorkspace(vscode.workspace.workspaceFolders[0].uri);
}

export function deactivate(): void {
    logger?.info('Smart FTP Deploy deactivated.');
    saveListener?.dispose();
    statusBarItem?.dispose();
    pool?.dispose().catch(() => {});
}
