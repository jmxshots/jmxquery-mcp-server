# JMX-QUERY MCP Server

JMX-QUERY MCP Server connects AI agents such as GitHub Copilot, Cursor, or Claude to Microsoft Dynamics 365 Business Central. It runs as one Windows service, speaks the Model Context Protocol (MCP), and reaches one or more Business Central systems through the JMX-QUERY app.

This manual is for administrators who install, configure, and operate the server. It is also shown in the Admin GUI under **Documentation**.

**Contents**

1. [Quick Reference](#quick-reference)
2. [Overview](#overview)
   - [Components](#components)
   - [Keys](#keys)
   - [Terms](#terms)
3. [Installation](#installation)
   - [Prerequisites](#prerequisites)
   - [Standard Installation](#standard-installation)
   - [Manual or Recovery Installation](#manual-or-recovery-installation)
4. [Connecting Business Central](#connecting-business-central)
   - [First Login](#first-login)
   - [Creating an Instance](#creating-an-instance)
   - [Selecting the Technical Company](#selecting-the-technical-company)
   - [Verifying the Connection](#verifying-the-connection)
5. [Connecting MCP Clients](#connecting-mcp-clients)
   - [Endpoints](#endpoints)
   - [VS Code and GitHub Copilot](#vs-code-and-github-copilot)
   - [Cursor](#cursor)
   - [Claude Desktop](#claude-desktop)
   - [Other Clients](#other-clients)
   - [Clients in the Local Network](#clients-in-the-local-network)
   - [What Agents Do](#what-agents-do)
6. [Operating the Service](#operating-the-service)
   - [Updating](#updating)
   - [Restarting](#restarting)
   - [Service Account for SSO](#service-account-for-sso)
   - [Removing the Service](#removing-the-service)
   - [Running in a Terminal](#running-in-a-terminal)
7. [Admin GUI Reference](#admin-gui-reference)
   - [Sessions](#sessions)
   - [Secrets](#secrets)
   - [Tool Tester](#tool-tester)
   - [Logs](#logs)
   - [Documentation](#documentation)
8. [Configuration Reference](#configuration-reference)
   - [Environment Variables](#environment-variables)
   - [Network Access and Firewall](#network-access-and-firewall)
9. [Backup and Restore](#backup-and-restore)
10. [Troubleshooting](#troubleshooting)
    - [Diagnostics](#diagnostics)
11. [Security Checklist](#security-checklist)

## Quick Reference

Run all commands in an **elevated PowerShell** in the repository folder.

| Task | Command |
| --- | --- |
| Install for the first time (interactive) | `npm run bootstrap` |
| Pull the latest version and update | `npm run service:update -- --pull` |
| Update after a manual `git pull` or a `.env` change | `npm run service:update` |
| Restart (code and `.env` unchanged) | `Restart-Service -DisplayName 'JMX-QUERY MCP Server'` |
| Remove the service | `npm run service:uninstall` |
| Change ports or keys | `npm run bootstrap` |

| Item | Value |
| --- | --- |
| Windows service | **JMX-QUERY MCP Server** (service name `jmxquerymcpserver.exe`) |
| Admin GUI | `http://<server>:5000/admin` (`MCP_PORT`) |
| MCP endpoint for clients | `http://<server>:5001/mcp/stream` (`MCP_STREAMABLE_PORT`) |
| Configuration and keys | `.env` in the repository folder |
| Business Central connections | `data/instances.enc` (encrypted) |
| Audit logs | `logs/` (one JSONL file per day) |
| Service wrapper logs | `build/daemon/` |

## Overview

### Components

```text
AI agent (VS Code, Cursor, Claude, ...)
        |  MCP over HTTP, Bearer JMXQ_MCPAPI_KEY
        v
JMX-QUERY MCP Server  (Windows service)  <--  Admin GUI /admin, Admin key
        |  OData V4, per-Instance credentials
        v
Business Central with the JMX-QUERY app  (one or more Instances)
```

- **One Windows service** provides the MCP endpoints (Streamable HTTP and SSE) and the Admin GUI.
- **The Admin GUI** manages Business Central connections, stored secrets, client configurations, and audit logs.
- **The JMX-QUERY app** must be installed in every Business Central system the server connects to. It executes the queries.

### Keys

The server uses three different keys. All of them are stored in `.env`.

| Key | Used by | Purpose |
| --- | --- | --- |
| `ADMIN_API_KEY` | Administrators | Login to the Admin GUI and Admin API. Never give it to MCP clients. |
| `JMXQ_MCPAPI_KEY` | MCP clients | Bearer key for the HTTP MCP endpoints. Shown on the Admin GUI **Connect** page. |
| `INSTANCE_MASTER_KEY` | The server only | Encrypts `data/instances.enc`. Without it, stored connections cannot be read. Back it up. |

### Terms

| Term | Meaning |
| --- | --- |
| **Instance** | One Business Central connection profile: endpoint, authentication, and technical Company. Agents choose an Instance by name on every call. |
| **Technical Company** | The Business Central Company the server uses internally for metadata calls (tables, fields, contexts). Each Instance has exactly one. |
| **Execution context** | A context defined in the JMX-QUERY app that determines which Companies a script may run in. |
| **Execution Company** | The Company a script runs in. The agent picks it from the execution context, and the server validates it before execution. |

`tenantId` is only an Entra ID OAuth tenant identifier. It is not a Business Central Company.

## Installation

### Prerequisites

- Windows 10, Windows 11, or Windows Server.
- Current Node.js LTS with `npm`.
- Network access from the server to each Business Central OData endpoint or to Business Central Online.
- Administrator rights on the server for installing, updating, or removing the service.
- A Business Central user, application, or service account with the required JMX-QUERY permissions.
- The [JMX-QUERY Business Central app](https://github.com/jmxshots/AL-JMX.QUERY) installed in every target Business Central system.
- For SSO: a domain service account that is an authorized Business Central user, see [Service Account for SSO](#service-account-for-sso).

### Standard Installation

1. Clone or extract the repository.

   ```powershell
   git clone <repository-url>
   Set-Location jmxquery-mcp-server
   ```

2. Run the bootstrap from an elevated PowerShell in the repository.

   ```powershell
   npm run bootstrap
   ```

3. Answer the prompts:
   - **Ports**: the main port `MCP_PORT` (Admin GUI and SSE) and the Streamable HTTP port `MCP_STREAMABLE_PORT`.
   - **Keys**: for `ADMIN_API_KEY` and `JMXQ_MCPAPI_KEY`, keep an existing value, generate a new one, or enter one manually.
   - **Windows service**: install or update the service. When declined, start the server manually with `npm start`.
   - **Clipboard**: optionally copy `ADMIN_API_KEY` to the clipboard for the first login.

Bootstrap then:

- installs dependencies, but only when they are missing or outdated;
- creates `.env` on first setup and generates `INSTANCE_MASTER_KEY` automatically (an existing master key is always kept);
- enables LAN access: a loopback `MCP_HOST` is changed to `0.0.0.0`, and the computer name is added to `MCP_CORS_ORIGINS`;
- builds the server and Admin GUI, then installs and starts the service.

All other settings in an existing `.env` are preserved. If `.env` contains template placeholders, a master key shorter than 32 characters, or an enabled Admin API without an Admin key, Bootstrap stops before changing anything.

The summary at the end shows the Admin URLs and ports. Keys are never printed; only their last four characters are shown. Continue with [Connecting Business Central](#connecting-business-central) and restrict network access as described in [Network Access and Firewall](#network-access-and-firewall).

### Manual or Recovery Installation

Use this sequence when `.env` must be rebuilt or the interactive bootstrap cannot be used.

1. Install dependencies and create `.env` from the template.

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

2. Generate three distinct secrets. This command prints a 96-character random value; run it once per key.

   ```powershell
   -join (1..48 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
   ```

3. Set `INSTANCE_MASTER_KEY` (at least 32 characters), `ADMIN_API_KEY`, and `JMXQ_MCPAPI_KEY` in `.env`. When recovering an existing installation, keep the original `INSTANCE_MASTER_KEY`; a new one cannot read the existing `data/instances.enc`.

4. Build and install the service.

   ```powershell
   npm run service:update
   ```

## Connecting Business Central

Business Central connections are configured only in the Admin GUI, never in `.env`. They are stored encrypted in `data/instances.enc`.

### First Login

1. Open the Admin GUI, initially `http://127.0.0.1:5000/admin` on the server.
2. Enter `ADMIN_API_KEY` from the clipboard or from `.env`. Clear the clipboard afterwards if Windows clipboard history is enabled.

### Creating an Instance

Select **New instance**, enter a stable name (agents use this name), and choose the authentication type:

| Authentication | Required fields | Base URL example |
| --- | --- | --- |
| `BASIC` | Base URL, Username, Password | `https://bc.example.com:7048/BC240/ODataV4/` |
| `NTLM` | Base URL, Username, Password | `http://bc-internal:7048/BC240/ODataV4/` |
| `SSO` | Base URL; the service account authenticates | `https://bc-internal.contoso.local:7049/Production/ODataV4/` |
| `OAUTH` | Tenant ID, Client ID, Client Secret, Environment | No Base URL; derived automatically |

- For `BASIC`, `NTLM`, and `SSO`, enter the full OData V4 service root of your Business Central server instance. A missing trailing slash is added automatically. Do not add a Company to the Base URL.
- For `OAUTH`, enter the Entra ID directory ID as Tenant ID and the Business Central Online environment name, for example `Production` or `Sandbox`. The server builds `https://api.businesscentral.dynamics.com/v2.0/<tenantId>/<environment>/ODataV4/`.
- For `SSO`, the service must run under a suitable domain account, see [Service Account for SSO](#service-account-for-sso).

### Selecting the Technical Company

1. Select **Test connection**. It checks the Base URL and authentication without saving.
2. Select **Load companies**. The server reads the available Companies directly from Business Central.
3. Select the technical Company and save the Instance.

Execution Companies are not configured here. Agents receive them from the execution contexts of the JMX-QUERY app, and the server validates them before each script execution.

Use **Enable** or **Disable** to control whether an Instance accepts new MCP requests. Running requests are not aborted.

### Verifying the Connection

Open **Tools** in the Admin GUI, select the new Instance, and run `jmxq_ping` or `jmxq_listInstances`. Use **Get examples** to retrieve sample queries from the Business Central system. See [Tool Tester](#tool-tester).

## Connecting MCP Clients

The **Connect** page of the Admin GUI generates a ready-to-copy configuration for each supported client. Choose **This MCP server** when the client runs on the server itself, or **Local network** when it runs on another computer.

HTTP clients authenticate with `JMXQ_MCPAPI_KEY`. **Show API key** on the **Connect** page displays it for 30 seconds and allows copying it.

### Endpoints

| Endpoint | Address |
| --- | --- |
| Streamable HTTP (recommended) | `http://<server>:<MCP_STREAMABLE_PORT>/mcp/stream`, or `MCP_PORT` when no separate port is configured |
| SSE connection | `http://<server>:<MCP_PORT>/mcp/sse` |
| SSE messages | `http://<server>:<MCP_PORT>/mcp/messages?sessionId=<id>` |

Clients send `Authorization: Bearer <JMXQ_MCPAPI_KEY>`.

### VS Code and GitHub Copilot

Add the configuration from **Connect** through the MCP configuration command of VS Code. VS Code prompts for the key instead of storing it in the file:

```json
{
  "inputs": [
    {
      "id": "jmxq-mcp-server-api-key",
      "type": "promptString",
      "description": "JMX-QUERY MCP API key",
      "password": true
    }
  ],
  "servers": {
    "jmxq-mcp-server": {
      "type": "http",
      "url": "http://127.0.0.1:5001/mcp/stream",
      "headers": {
        "Authorization": "Bearer ${input:jmxq-mcp-server-api-key}"
      }
    }
  }
}
```

### Cursor

Copy the entry from **Connect** into Cursor's MCP configuration and replace `<JMXQ_MCPAPI_KEY>` with the MCP key:

```json
{
  "mcpServers": {
    "jmxq-mcp-server": {
      "url": "http://127.0.0.1:5001/mcp/stream",
      "headers": {
        "Authorization": "Bearer <JMXQ_MCPAPI_KEY>"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop starts its own local server process over Stdio. This works only on the server computer itself, where the repository and Node.js are installed. It does not use the HTTP endpoint or `JMXQ_MCPAPI_KEY`.

Copy the entry from **Connect** into Claude Desktop's MCP configuration and restart Claude Desktop. The Admin GUI fills in the actual paths. `JMXQ_STDIO_ONLY=true` prevents a conflict with the running service.

```json
{
  "mcpServers": {
    "jmxq-mcp-server": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["build/index.js"],
      "cwd": "C:\\path\\to\\jmxquery-mcp-server",
      "env": {
        "JMXQ_STDIO_ONLY": "true"
      }
    }
  }
}
```

### Other Clients

**Connect** also generates configurations for these clients. All of them use the Streamable HTTP endpoint; replace `<JMXQ_MCPAPI_KEY>` or provide it as an environment variable of the same name.

| Client | Configuration |
| --- | --- |
| Claude Code | `claude mcp add` command |
| Hermes Agent | `~/.hermes/config.yaml` |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |

### Clients in the Local Network

1. Make sure `MCP_HOST` is `0.0.0.0` or the server's LAN address. Bootstrap sets `0.0.0.0` by default.
2. Open the Streamable HTTP port in Windows Firewall, see [Network Access and Firewall](#network-access-and-firewall).
3. In **Connect**, choose **Local network** and the server's DNS name or IP address, then copy the configuration to the client computer.

Example: `http://bc-mcp-server:5001/mcp/stream`. Never use `127.0.0.1` or `localhost` on another computer; those addresses point to the client itself.

### What Agents Do

Agents need no extra instructions; the server sends its workflow rules when a client connects. Knowing the workflow helps when reading the [Logs](#logs):

1. `jmxq_listInstances` returns the enabled Instances. With one Instance the agent uses it automatically; with several it asks the user.
2. Every further call names the Instance explicitly (`bcInstance`). Agents do not keep a "current" Instance between calls.
3. `jmxq_searchTables`, `jmxq_describeTableFields`, `jmxq_getGrammar`, and `jmxq_getExamples` explore the data model and the query language.
4. `jmxq_listExecutionContexts` and `jmxq_describeExecutionContext` provide the allowed execution Companies.
5. `jmxq_executeScript` runs the query in the chosen execution Company.

`jmxq_executeScript` can also run `INSERT`, `MODIFY`, `DELETE`, or `RUN CODEUNIT`, and is therefore marked as potentially destructive. What a script may change is controlled by the permissions of the Business Central account configured on the Instance.

## Operating the Service

The service **JMX-QUERY MCP Server** runs the built server from `build/` and starts automatically with Windows.

The service definition contains a copy of all `.env` values. A plain restart therefore keeps the old values; after every `.env` change, run `npm run service:update`.

### Updating

```powershell
npm run service:update -- --pull
```

Without `--pull`, the update uses the current state of the folder, for example after a manual `git pull` or a `.env` change. The update runs without prompts:

1. Checks administrator rights. With `--pull`, it runs `git pull --ff-only` for the current branch. The pull is refused when tracked files have local changes and never creates a merge.
2. Validates `.env` without changing it.
3. Installs dependencies, but only when they changed.
4. Rebuilds the server and Admin GUI. The service keeps running during the build.
5. Re-applies the service definition and restarts the service, but only after a successful build.

If any step fails, the update stops and the running service is left unchanged. Back up before larger upgrades, see [Backup and Restore](#backup-and-restore).

To change ports or keys, run `npm run bootstrap` instead; `service:update` never modifies `.env`.

### Restarting

```powershell
Restart-Service -DisplayName 'JMX-QUERY MCP Server'
```

A restart is enough when neither the code nor `.env` has changed, for example after changing the service account. Active Admin GUI sessions end with the restart.

### Service Account for SSO

By default the service runs as `LocalSystem`, which usually cannot authenticate to a remote Business Central server with Windows authentication. For `SSO` Instances:

1. Open `services.msc` and select **JMX-QUERY MCP Server**.
2. Open **Properties > Log On** and enter an approved domain service account that is an authorized Business Central user.
3. Restart the service.

The account needs read and write access to the repository folder, in particular `data/` and `logs/`.

### Removing the Service

```powershell
npm run service:uninstall
```

The command stops the service, removes it, and deletes the service wrapper in `build/daemon/`. `.env`, `data/`, and `logs/` are kept, so `npm run service:update` reinstalls the service with the existing configuration and connections.

If the command reports that the service is marked for deletion, close `services.msc` and run it again, or reboot.

### Running in a Terminal

For a quick test without the service, stop the service and run:

```powershell
npm start
```

The output appears in the terminal; `Ctrl+C` stops the server. If the ports are still in use, `npm start -- --force-ports` terminates every process listening on `MCP_PORT` or `MCP_STREAMABLE_PORT` first. Use it with care.

## Admin GUI Reference

The Admin GUI runs at `/admin` on `MCP_PORT`. Its pages are **Instances**, **Connect**, **Tools**, **Logs**, and **Documentation**.

### Sessions

The login asks only for `ADMIN_API_KEY`; the key is not stored in the browser. A session ends on **Sign out**, on a server restart, after `ADMIN_SESSION_IDLE_MINUTES` without activity (default 60), or `ADMIN_SESSION_MAX_HOURS` after login (default 12).

### Secrets

Stored passwords and client secrets are masked. The reveal icon asks for the Admin key again and shows a single secret for 30 seconds.

### Tool Tester

**Tools** runs the MCP tools exactly like an MCP client, including validation and audit logging.

- Select an Instance. For scripts, also select an execution context and an execution Company.
- **Get examples** loads sample queries published by the selected Business Central system.
- `jmxq_executeScript` asks for confirmation, because scripts can change data.
- The result shows the request ID, duration, effective execution context, and full response.

### Logs

**Logs** shows all tool calls with filters for Instance, Company, Tool, Status, Request ID, and time range, plus counts, errors, and average durations.

- Logs contain target, timing, execution context, sanitized errors, and the script text of `jmxq_executeScript`.
- Logs never contain Business Central data, passwords, client secrets, tokens, or Authorization headers.
- Files older than `LOG_RETENTION_DAYS` are deleted automatically. **Clear logs** deletes older files manually, or all files with **Delete all logs**.

### Documentation

**Documentation** shows this manual. **Visual overview** opens an illustrated summary of architecture, setup, client configuration, agent workflow, and security in a new tab.

## Configuration Reference

### Environment Variables

`.env` in the repository folder contains only global settings. After any change, run `npm run service:update`.

| Variable | Description | Default |
| --- | --- | --- |
| `MCP_HOST` | Listening interface. Bootstrap sets `0.0.0.0` (all interfaces). | `127.0.0.1` |
| `MCP_PORT` | Port for the Admin GUI and SSE. | `5000` |
| `MCP_STREAMABLE_PORT` | Separate port for Streamable HTTP. | unset |
| `MCP_CORS_ORIGINS` | Comma-separated browser origins allowed to call the server. | local origins |
| `JMXQ_MCPAPI_KEY` | Key for MCP clients. | unset |
| `ADMIN_API_ENABLED` | Enables the Admin GUI and Admin API. | `false` |
| `ADMIN_API_KEY` | Key for the Admin GUI. Required when the Admin API is enabled. | unset |
| `ADMIN_SESSION_IDLE_MINUTES` | Admin session idle timeout in minutes (1-1440). | `60` |
| `ADMIN_SESSION_MAX_HOURS` | Maximum Admin session length in hours (1-168). | `12` |
| `INSTANCE_MASTER_KEY` | Encryption key for the Instance Store. Required, at least 32 characters. | unset |
| `INSTANCE_STORE_PATH` | Path of the Instance Store. | `./data/instances.enc` |
| `LOG_DIR` | Directory for audit logs. | `./logs` |
| `LOG_RETENTION_DAYS` | Number of daily log files to keep. | `30` |
| `LOG_SCRIPT_MAX_LENGTH` | Maximum logged script length. | `4000` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. | `info` |
| `MCP_STDIO` | Stdio transport for locally launched clients: `auto`, `on`, or `off`. The service always uses `off`. | `auto` |

### Network Access and Firewall

Bootstrap configures the server for the local network (`MCP_HOST=0.0.0.0`). Protect it with the Windows Firewall:

- Allow inbound traffic only in the **Private** profile and only from trusted client addresses.
- Open `MCP_STREAMABLE_PORT` for MCP clients. Open `MCP_PORT` only if the Admin GUI must be reachable from other computers.
- Never expose the server to the internet. Use a reverse proxy with TLS for access beyond the local network.

To allow access only from the server itself, set `MCP_HOST=127.0.0.1` and run `npm run service:update`. Running `npm run bootstrap` again resets it to `0.0.0.0`.

## Backup and Restore

Back up these files, ideally with the service stopped:

| File | Contents |
| --- | --- |
| `.env` | Settings and all three keys, including `INSTANCE_MASTER_KEY`. |
| `data/instances.enc` | All Instances and their credentials, encrypted. |
| `logs/` | Audit history, if it must be retained. |

`data/instances.enc` can only be read with the matching `INSTANCE_MASTER_KEY`. Always back up both together, and never edit `instances.enc` manually.

To restore on the same or a new server:

1. Install the server as described in [Installation](#installation), or stop the existing service.
2. Copy `.env`, `data/instances.enc`, and optionally `logs/` into the repository folder.
3. Run `npm run service:update`.
4. Log in to the Admin GUI and verify the Instances with the [Tool Tester](#tool-tester).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Service does not start | Read `build/daemon/jmxquerymcpserver.err.log`. Check that `INSTANCE_MASTER_KEY` has at least 32 characters and that `ADMIN_API_KEY` is set when `ADMIN_API_ENABLED=true`. |
| `.env` change has no effect | Run `npm run service:update`. A plain restart keeps the old values. |
| Update or uninstall reports missing rights | Use an elevated PowerShell. |
| `--pull` refuses to run | Commit or discard local changes in tracked files, or run `git pull` manually. If Git reports "dubious ownership", run `git config --global --add safe.directory <path>`. |
| Port already in use | Find the process with `Get-NetTCPConnection -LocalPort 5000`. For a terminal session, `npm start -- --force-ports` terminates it. |
| Admin login fails | Check `ADMIN_API_ENABLED=true` and use `ADMIN_API_KEY`, not the MCP key. |
| MCP client receives `401` | The client must send `JMXQ_MCPAPI_KEY` as Bearer token. |
| LAN client cannot connect | Check `MCP_HOST`, the firewall rule, and that the client does not use `127.0.0.1` or `localhost`. |
| Agent finds no Instance | Create and enable an Instance with a technical Company. |
| SSO works in a terminal but not as a service | Configure the service account, see [Service Account for SSO](#service-account-for-sso). |
| OAuth fails | Check Tenant ID, Client ID, Client Secret, Environment, admin consent in Entra ID, and the permissions of the Business Central application user. |
| Documentation page is empty | The service account must be able to read `README.md` in the repository folder. |

### Diagnostics

**Service status and logs**

```powershell
Get-Service -DisplayName 'JMX-QUERY MCP Server'
Get-Content build\daemon\jmxquerymcpserver.err.log -Tail 30
```

The server writes its startup and runtime messages to `jmxquerymcpserver.err.log`; `jmxquerymcpserver.wrapper.log` records service starts and stops.

**Admin API test**

```powershell
curl.exe -i http://127.0.0.1:5000/admin/api/instances `
  -H "Authorization: Bearer <ADMIN_API_KEY>"
```

`200 OK` with a JSON list means the server and Admin key work. `401 Unauthorized` means the key is wrong.

**MCP test**

Use a recent MCP Inspector release (`npx @modelcontextprotocol/inspector`), choose **Streamable HTTP**, connect to `/mcp/stream`, and add the header `Authorization: Bearer <JMXQ_MCPAPI_KEY>`. Never put keys in a URL.

## Security Checklist

- Use three different random values for `ADMIN_API_KEY`, `JMXQ_MCPAPI_KEY`, and `INSTANCE_MASTER_KEY`.
- Give MCP clients only `JMXQ_MCPAPI_KEY`, never `ADMIN_API_KEY`.
- Restrict file access to `.env`, `data/`, and `logs/` to administrators and the service account.
- Limit network access with the Windows Firewall and never expose the server to the internet.
- Give each Instance a Business Central account with only the permissions agents actually need.
- Treat audit logs as sensitive: they contain the executed scripts.
- Rotate Business Central credentials in the Admin GUI. Changing `INSTANCE_MASTER_KEY` makes `data/instances.enc` unreadable; the Instances must then be recreated.
