# Remove MBIF Vault

MBIF is a real third-party tool with its own update/uninstall story — this
skill doesn't own its lifecycle and doesn't try to fully reverse an MBIF
install. It only reverses what this skill itself did: deriving and wiring
`briefer.md`.

## 1. Remove the Briefer derivation and the seeded Digester

```bash
rm -f "<vault-path>/.claude/agents/briefer.md"
rm -f "<vault-path>/.claude/agents/digester.md"
```

## 2. Unwire it from `briefing-host`

Reset the group's `groups/<folder>/host-shims/briefing-host` `VAULT_PATH`
back to the placeholder (or point it at a different vault/script).

## 3. Disable the group's projected lifecycle, if it should stop entirely

```bash
ncl projected-sessions disable --id <group-id>
ncl groups restart --id <group-id>
```

## 4. Remove MBIF itself (optional, out of scope for this skill)

If the operator wants MBIF fully gone from the vault, not just
Briefer — that's between them and MBIF's own docs, not this skill:

```bash
rm -rf "<vault-path>/My-Brain-Is-Full-Crew"
```

Note MBIF's installer also wrote directly into `<vault-path>/.claude/`
(agents, skills, hooks, MCP config) — deleting the cloned repo directory
above does **not** remove those. Check MBIF's own docs for its uninstall
story before hand-deleting `.claude/` contents, since other things in that
vault may depend on files it installed.
