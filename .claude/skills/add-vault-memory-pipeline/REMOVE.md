# Remove Vault Memory Pipeline

The pipeline's code is part of `add-memory-stack`; remove it with that skill's
[REMOVE.md](../add-memory-stack/REMOVE.md).

To stop only the *scheduled digests* while keeping live export:

```bash
ncl host-cron-jobs list --id <group-id>
ncl host-cron-jobs delete --job-id <id>      # the digest-daily / digest-rollup rows
```

To stop live export for one group: `ncl vault-transcripts disable --id <group-id>`.
