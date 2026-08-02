# Remove MBIF Vault

MBIF is a real third-party tool with its own update/uninstall story — this
skill doesn't own its lifecycle and doesn't try to fully reverse an MBIF
install. It only reverses what this skill itself did: deriving and wiring
`briefer.md`.

## 1. Remove the Briefer derivation, the seeded Digester, and its vault tooling

```bash
rm -f "<vault-path>/.claude/agents/briefer.md"
rm -f "<vault-path>/.claude/agents/digester.md"
rm -f "<vault-path>/Meta/scripts/link-index"
rm -f "<vault-path>/Meta/scripts/number-digest-blocks"
rm -f "<vault-path>/Meta/naming-conventions.md"
```

Check whether anything else in the vault depends on `naming-conventions.md`
before removing it — other agents/skills the operator has added since may
reference it.

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
