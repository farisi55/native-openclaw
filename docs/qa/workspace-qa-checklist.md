# Functional Workspace QA Checklist

This checklist validates that `workspace/` is a functional local-first agent home, not a decorative folder.

## Automated Commands

Run from the project root:

```bash
npm run build
npm run test:workspace
npm run test:qa
```

Expected:

- TypeScript build exits with status `0`.
- `test/workspace.test.js` passes.
- `test/workspace-qa.test.js` passes.
- No real provider, Telegram, Brevo, or external network call is required.

## Covered Automated Areas

- Workspace initialization creates `state/`, `memory/`, `reports/`, `artifacts/`, `backup/`, and `trash/`.
- Core Markdown files are created and existing files are preserved.
- Safe path resolution blocks traversal and absolute outside paths.
- Workspace tools are registered and executable.
- Workspace context is injected into prompts with bounded file excerpts.
- Workspace memory writes update `MEMORY.md` and `memory/YYYY-MM-DD.md`.
- Natural-language file actions route through workspace safety.
- `system-execute` uses workspace cwd when configured.
- Workspace backup excludes the backup directory itself.
- CLI, API, and Telegram-compatible paths can read/write workspace data.
- `WORKFLOW.md` can drive a non-gold workflow topic.
- Autocomplete includes workspace and memory commands.

## Manual Smoke Test

Use a disposable workspace:

```bash
set WORKSPACE_DIR=C:\tmp\native-openclaw-workspace-smoke
npm run build
npm start
```

Then run:

```text
/workspace info
/workspace list
/workspace read IDENTITY.md
/memory show
buat file NOTES.md di workspace berisi test
tulis file ../outside.txt
/workspace backup
/exit
```

Expected:

- `/workspace info` shows the temp workspace root and all core files as present.
- `/workspace list` shows Markdown core files and workspace folders.
- `/workspace read IDENTITY.md` shows the agent identity.
- `/memory show` reads `MEMORY.md`.
- `NOTES.md` is created inside the workspace.
- `../outside.txt` is blocked.
- `/workspace backup` creates `workspace/backup/workspace-backup-...`.

## API Smoke Test

Set:

```bash
API_ENABLED=true
API_HOST=127.0.0.1
API_PORT=18789
```

Start the app, then send:

```bash
curl -s http://127.0.0.1:18789/native-openclaw/v1/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"baca WORKFLOW.md\"}"
```

Expected:

- HTTP status `200`.
- `result` contains workflow content or a safe summary.
- `error_detail` is empty.

## Troubleshooting

- If no workspace tools are listed, verify `TOOLS_DIR=./tools` or run from the project root.
- If tests fail on MCP spawning, run the full suite with permission to spawn child Node processes.
- If workspace paths resolve outside the temp root, check `WORKSPACE_ALLOW_OUTSIDE_PATHS=false`.
- If `system-execute` cwd is not workspace, check `SYSTEM_EXECUTE_DEFAULT_CWD=workspace`.
