import * as vscode from 'vscode';

export interface SmartFtpConfig {
    host: string;
    port: number;
    username: string;
    password: string;
    secure: boolean;
    remotePath: string;
    autoUpload: boolean;
    debugMode: boolean;
    retryCount: number;
    retryDelay: number;
    connectionTimeout: number;
    exclude: string[];
}

export class ConfigService {
    private config!: SmartFtpConfig;
    private readonly logger: { info: (msg: string) => void; warn: (msg: string) => void };

    constructor(logger: { info: (msg: string) => void; warn: (msg: string) => void }) {
        this.logger = logger;
        this.reload();
    }

    public reload(): void {
        const raw = vscode.workspace.getConfiguration('smartFtp');
        this.config = {
            host: raw.get<string>('host', '').trim(),
            port: raw.get<number>('port', 21),
            username: raw.get<string>('username', '').trim(),
            password: raw.get<string>('password', ''),
            secure: raw.get<boolean>('secure', false),
            remotePath: this.normalizeRemotePath(raw.get<string>('remotePath', '/')),
            autoUpload: raw.get<boolean>('autoUpload', true),
            debugMode: raw.get<boolean>('debugMode', false),
            retryCount: raw.get<number>('retryCount', 3),
            retryDelay: raw.get<number>('retryDelay', 2000),
            connectionTimeout: raw.get<number>('connectionTimeout', 30000),
            exclude: raw.get<string[]>('exclude', [
                '.git',
                'node_modules',
                '.vscode',
                'out',
                'dist',
                '.DS_Store',
                'Thumbs.db',
            ]),
        };
    }

    public getConfig(): SmartFtpConfig {
        return { ...this.config };
    }

    public validate(): string[] {
        const errors: string[] = [];
        if (!this.config.host) {
            errors.push('"smartFtp.host" is not configured.');
        }
        if (!this.config.username) {
            errors.push('"smartFtp.username" is not configured.');
        }
        if (this.config.port < 1 || this.config.port > 65535) {
            errors.push('"smartFtp.port" must be between 1 and 65535.');
        }
        return errors;
    }

    private normalizeRemotePath(path: string): string {
        const trimmed = path.trim();
        if (!trimmed || trimmed === '') {
            return '/';
        }
        // Ensure it starts with a forward slash
        return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }
}
