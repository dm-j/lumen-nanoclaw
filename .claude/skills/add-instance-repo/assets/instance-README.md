# NanoClaw instance repo

Everything specific to one NanoClaw install, kept out of the generic fork: agent groups (personas,
workspaces), and the host/MCP shim scripts. In the NanoClaw checkout, `groups/`, `mcp-shims/` and
`host-shims/` are gitignored symlinks into this repo.

```
groups/        one folder per agent group
host-shims/    _pool/  _registry.json  _state/       scripts the host runs on an agent's behalf
mcp-shims/     _pool/  _registry.json  lib/  _state/ scripts exposed to agents as MCP tools
```

Commits here are made automatically by the NanoClaw checkout's `post-commit` hook and are never pushed;
push deliberately. Keep this repo private: shims routinely hardcode paths and addresses.
