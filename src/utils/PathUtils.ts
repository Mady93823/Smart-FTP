import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Convert a local file URI to the corresponding remote path.
 *
 * @param localUri      The local file URI.
 * @param workspaceUri  The workspace root URI.
 * @param remotePath    The configured remote base path (e.g. "/public_html").
 * @returns             The absolute remote path, always using forward slashes.
 */
export function localToRemotePath(
    localUri: vscode.Uri,
    workspaceUri: vscode.Uri,
    remotePath: string
): string {
    const localFsPath = localUri.fsPath;
    const workspaceFsPath = workspaceUri.fsPath;

    // Compute relative path from workspace root
    let relative = path.relative(workspaceFsPath, localFsPath);

    // Normalise to forward slashes (important on Windows)
    relative = relative.replace(/\\/g, '/');

    // Combine with the configured remote base path
    const base = remotePath.endsWith('/') ? remotePath.slice(0, -1) : remotePath;
    return `${base}/${relative}`;
}

/**
 * Given a remote file path and the configured remote base path, return the
 * corresponding local path inside the workspace.
 */
export function remoteToLocalPath(
    remotePath: string,
    remoteBase: string,
    workspaceUri: vscode.Uri
): string {
    let relative = remotePath;
    if (remotePath.startsWith(remoteBase)) {
        relative = remotePath.slice(remoteBase.length);
    }
    // Strip leading slash
    relative = relative.replace(/^\//, '');

    // Convert to platform-specific path separator
    const localRelative = relative.split('/').join(path.sep);
    return path.join(workspaceUri.fsPath, localRelative);
}

/**
 * Compute all ancestor directories (inclusive) for a given remote path,
 * ordered from shallowest to deepest.
 *
 * e.g. "/public_html/css/style.css" → ["/public_html", "/public_html/css"]
 */
export function getAncestorDirs(remoteFilePath: string): string[] {
    const parts = remoteFilePath.split('/').filter((p) => p.length > 0);
    const dirs: string[] = [];
    for (let i = 1; i < parts.length; i++) {
        dirs.push('/' + parts.slice(0, i).join('/'));
    }
    return dirs;
}

/**
 * Returns true when the given name matches any of the exclusion patterns.
 * Supports simple glob wildcards (*, **) via basic string matching without
 * pulling in an extra dependency at this level.
 */
export function isExcluded(name: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (matchGlob(name, pattern)) {
            return true;
        }
    }
    return false;
}

/**
 * Minimal glob matcher supporting * and ** wildcards.
 */
function matchGlob(value: string, pattern: string): boolean {
    // Exact match
    if (value === pattern) {
        return true;
    }
    // Convert glob to regex
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '<<<DOUBLE>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLE>>>/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(value);
}

/**
 * Ensure a remote path string starts with "/" and does not end with "/"
 * unless it IS the root itself.
 */
export function normalizeRemotePath(p: string): string {
    let normalized = p.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

/**
 * Get the remote directory containing the given remote file path.
 */
export function remoteDir(remoteFilePath: string): string {
    const idx = remoteFilePath.lastIndexOf('/');
    if (idx <= 0) {
        return '/';
    }
    return remoteFilePath.slice(0, idx);
}
