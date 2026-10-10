# MONO HQ · Financial AI Office

**An interactive offline UI preview and a Claude Code implementation starter.**

### See the UI now

Mac: double-click `index.html` or run `open index.html` in Terminal from this directory. On Windows, double-click `index.html`.

The Office shows eight small characters at their desks. Press **התחל הדגמה** to watch labeled *simulated* tasks and activity bubbles. Click an agent to inspect their mission. Navigate to the Automations and Activity tabs. This preview uses no external dependencies, AI calls, network requests or account credentials.

### Build the real system in Claude Code

1. Create a new folder/repository or copy this starter into the desired app repository. Keep the finance project context files nearby, but do not commit personally identifying bank exports or any secrets.
2. In Terminal: `cd /path/to/MONO_HQ_Starter` and start Claude Code with `claude --model claude-sonnet-5-5` after verifying the installed version supports the model.
3. Paste the contents of `CLAUDE_CODE_BUILD_PROMPT.md` into the Claude Code session. Ask Claude to treat the starter UI as the design reference and build the backend + production front-end.
4. Before enabling actual AI jobs, review the environment variables, permissions, cost controls and connected financial data sources. Do not enter bank passwords into a prompt.

### Included files

- `index.html`: actual interactive but **offline simulated** UI.
- `CLAUDE_CODE_BUILD_PROMPT.md`: detailed prompt to implement the real app in the target repository.
- `.claude/agents/*.md`: eight specialist agent definitions, explicitly pinned to Sonnet 5.5.
- `.claude/settings.json`: sample configuration to force Sonnet 5.5 for subagents (version-specific; verify compatibility).
- `automation/schedules.json`: desired *inactive* schedule definitions.
- `spec/events.schema.json`: draft public activity event schema for live backend.
- `SYSTEM_ARCHITECTURE.md`: high-level implementation and security expectations.

### Honest scope

This is **not** a live Claude Code office, recurring worker, regulated financial adviser or bank connector yet. It is a working UI prototype plus project blueprint for the build that will integrate those pieces. Running `index.html` does not create automations or read bank data.
