# Smart FTP Deploy

A modern, production-ready VS Code extension for deploying files to FTP/FTPS servers — with best-in-class compatibility for servers that work in FileZilla but fail in other extensions.

---

## Features

| Feature | Description |
|---|---|
| **Auto Upload on Save** | Automatically uploads the active file every time you save |
| **Upload Current File** | Manually upload the open file to the FTP server |
| **Upload Workspace** | Recursively upload the entire workspace folder |
| **Download Current File** | Download the remote counterpart of the active file |
| **Sync Workspace** | Compare local and remote, upload/download as needed |
| **Create Remote Directories** | Missing parent directories are created automatically |
| **Upload Progress** | VS Code progress notifications per file and for bulk uploads |
| **Retry Logic** | Failed transfers are retried with configurable count and delay |
| **Detailed Logging** | Every FTP command and reply is logged to the *Smart FTP* Output Channel |
| **FTP + FTPS** | Supports plain FTP and FTP-over-TLS (implicit) |

---

## FTP Compatibility

This extension is specifically designed to connect to FTP servers that fail in other extensions but work in FileZilla:

- **Passive mode** (PASV) is always used
- **NAT-translated** server IP addresses in PASV replies are handled transparently by `basic-ftp`
- **Unusual PASV responses** are tolerated
- **Self-signed / untrusted TLS certificates** are accepted (mirrors FileZilla's permissive mode)
- **Connection timeouts** are configurable
- **Automatic retry** reconnects and retries failed operations

---

## Installation & Build

### Prerequisites

- Node.js 18+ with npm
- VS Code 1.85+

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Compile TypeScript
npm run compile

# 3. Open in VS Code and press F5 to run in Extension Development Host
code .
```

### Watch Mode (for development)

```bash
npm run watch
```

---

## Configuration

Add these settings to your VS Code `settings.json` (Workspace or User scope):

```json
{
  "smartFtp.host": "ftp.example.com",
  "smartFtp.port": 21,
  "smartFtp.username": "myuser",
  "smartFtp.password": "mypassword",
  "smartFtp.secure": false,
  "smartFtp.remotePath": "/public_html",
  "smartFtp.autoUpload": true,
  "smartFtp.debugMode": false,
  "smartFtp.retryCount": 3,
  "smartFtp.retryDelay": 2000,
  "smartFtp.connectionTimeout": 30000,
  "smartFtp.exclude": [
    ".git",
    "node_modules",
    ".vscode",
    "out",
    "dist"
  ]
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `smartFtp.host` | `string` | `""` | FTP server hostname or IP |
| `smartFtp.port` | `number` | `21` | FTP server port |
| `smartFtp.username` | `string` | `""` | FTP login username |
| `smartFtp.password` | `string` | `""` | FTP login password |
| `smartFtp.secure` | `boolean` | `false` | Use FTPS (FTP over TLS) |
| `smartFtp.remotePath` | `string` | `"/"` | Remote base path |
| `smartFtp.autoUpload` | `boolean` | `true` | Upload on every save |
| `smartFtp.debugMode` | `boolean` | `false` | Verbose FTP reply logging |
| `smartFtp.retryCount` | `number` | `3` | Max retry attempts |
| `smartFtp.retryDelay` | `number` | `2000` | ms between retries |
| `smartFtp.connectionTimeout` | `number` | `30000` | Connection timeout in ms |
| `smartFtp.exclude` | `string[]` | `[".git", "node_modules", …]` | Files/folders to exclude |

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for:

| Command | Description |
|---|---|
| `Smart FTP: Upload Current File` | Upload the active editor file |
| `Smart FTP: Upload Workspace` | Upload all files in the workspace |
| `Smart FTP: Download Current File` | Download remote → overwrite local |
| `Smart FTP: Test Connection` | Verify FTP credentials and connectivity |
| `Smart FTP: Sync Workspace` | Bidirectional sync based on timestamps |

---

## Output Channel / Logging

Open **View → Output** and select **Smart FTP** from the dropdown to see:

- Connection attempts and server greeting
- Login success / failure with server reply codes
- PASV negotiation (visible with `smartFtp.debugMode: true`)
- Per-file upload / download operations
- Retry attempts with delay countdown
- Error details and stack traces

Enable `"smartFtp.debugMode": true` to see every raw FTP command and server reply.

---

## Sync Logic

The **Sync Workspace** command uses file modification timestamps:

1. Scans the remote directory recursively
2. Scans the local workspace (respecting exclusions)
3. For files present both locally and remotely: uploads if local is newer by >2 seconds
4. Uploads files that exist locally but not remotely
5. Downloads files that exist remotely but not locally

---

## Project Structure

```
smart-ftp-deploy/
├── src/
│   ├── extension.ts          # Activation, command registration, save listener
│   ├── config/
│   │   └── ConfigService.ts  # Reads & validates smartFtp.* settings
│   ├── ftp/
│   │   ├── FtpClient.ts      # basic-ftp wrapper with retry & logging
│   │   ├── UploadManager.ts  # Single-file & workspace upload
│   │   ├── DownloadManager.ts# Remote → local download
│   │   └── SyncManager.ts    # Bidirectional timestamp-based sync
│   └── utils/
│       ├── Logger.ts         # Timestamped output channel logger
│       └── PathUtils.ts      # Local ↔ remote path conversion
├── package.json
├── tsconfig.json
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
