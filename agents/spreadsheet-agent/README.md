# Spreadsheet Agent

Optional HTTP worker for spreadsheet reads, writes, and report generation.
Credentials are never committed. Configure Google credentials or
`SPREADSHEET_MCP_URL` inside the worker environment.

```bash
docker compose --profile spreadsheet up -d
```

