# Remove Projected Sessions

The code is part of `add-memory-stack`; remove it with that skill's
[REMOVE.md](../add-memory-stack/REMOVE.md). Projected sessions cannot be removed
on its own: the vault transcript export and attachment captioning share its
helpers.

To switch it off without removing code: `ncl projected-sessions disable --id
<group-id>` and `ncl groups restart --id <group-id>`.
