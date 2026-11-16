# MCP bridge

The CLI includes an MCP (Model Context Protocol) bridge that connects AI tools to the decision
editor. Studio's editor does not connect to it yet (planned, see Donka's roadmap); the bridge's
REST endpoints work on their own.

```bash
donka mcp start
```

This starts a local server on `localhost:41919` that:

- Exposes an **MCP endpoint** (`/mcp`) for AI tool integration
- Connects to the editor via **WebSocket**
- Provides **REST endpoints** for evaluating decisions and fetching files

## Options

| Flag         | Description           | Default     |
| ------------ | --------------------- | ----------- |
| `-p, --port` | Server port           | `41919`     |
| `-h, --host` | Server host           | `localhost` |
| `-u, --url`  | Donka Studio URL      | —           |
| `--open`     | Open browser on start | `false`     |

## REST Endpoints

**Evaluate a decision graph:**

```bash
curl -X POST http://localhost:41919/evaluate/my-decision \
  -H "Content-Type: application/json" \
  -d '{"context": {"customer": {"tier": "premium"}, "orderTotal": 150}}'
```

**Retrieve a decision file:**

```bash
curl http://localhost:41919/file/my-decision
```

## AI Tool Configuration

```json
{
  "mcpServers": {
    "donka": {
      "command": "donka",
      "args": ["mcp", "start"]
    }
  }
}
```
