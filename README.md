# JMX-QUERY MCP Server

This is a Model Context Protocol (MCP) server that exposes JMX-QUERY functions from Microsoft Business Central (On-Premise) to AI agents.

## Features

- **SSE Transport**: Supports HTTP + Server-Sent Events for broad client compatibility.
- **Multi-Client**: Supports multiple concurrent AI clients via `clientId` mapping.
- **BC Integration**: Optimized for Business Central OData V4 Actions with "double-parsing" support.
- **JMX-QUERY Tools**:
  - `jmxq_getGrammar`
  - `jmxq_getExamples`
  - `jmxq_getReadmeApi`
  - `jmxq_describeExecutionContext`
  - `jmxq_describeTableFields`
  - `jmxq_executeScript`

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   - Copy `.env.example` to `.env`
   - Fill in your Business Central credentials and OData URL.

3. **Run Server**:
   ```bash
   # Development mode (auto-reload)
   npm run dev

   # Production mode
   npm run build
   npm run start
   ```

## API Endpoints

- **SSE**: `GET /mcp/sse?clientId=<any-id>`
- **Messages**: `POST /mcp/messages` (requires `X-MCP-ClientId` header)

## Testing with cURL

See `MCP_SERVER_PLAN.md` for detailed cURL commands to smoke test the SSE and Message endpoints.
