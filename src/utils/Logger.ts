import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

export class Logger {
    private readonly channel: vscode.OutputChannel;
    private debugEnabled: boolean = false;

    constructor(channelName: string) {
        this.channel = vscode.window.createOutputChannel(channelName);
    }

    public setDebugMode(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    public show(): void {
        this.channel.show(true);
    }

    public debug(message: string): void {
        if (this.debugEnabled) {
            this.log('DEBUG', message);
        }
    }

    public info(message: string): void {
        this.log('INFO ', message);
    }

    public warn(message: string): void {
        this.log('WARN ', message);
    }

    public error(message: string, err?: unknown): void {
        this.log('ERROR', message);
        if (err instanceof Error) {
            this.log('ERROR', `  Stack: ${err.stack ?? err.message}`);
        } else if (err !== undefined) {
            this.log('ERROR', `  Detail: ${String(err)}`);
        }
    }

    public separator(): void {
        this.channel.appendLine('─'.repeat(60));
    }

    public dispose(): void {
        this.channel.dispose();
    }

    private log(level: string, message: string): void {
        const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
        this.channel.appendLine(`[${timestamp}] [${level}] ${message}`);
    }
}
