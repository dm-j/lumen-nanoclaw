# Fresh-install gaps

Found 2026-09-23 while writing [../fresh-install.md](../fresh-install.md). Nothing here is built.

- **PrefixRouter has no git remote.** `~/Projects/PrefixRouter` is a git repo with no origin; config (`config.json`) and code exist only on this disk. Fix: create a private GitHub repo and push. Its launchd plist also embeds a OneCLI agent token, so don't commit generated plists.
- **The vault has no remote.** `nightly-commit.sh` commits locally and never pushes (its own comment: "upgrade to remote backup if needed"). It is Lumen's memory. Fix: private remote, or an encrypted off-machine mirror.
- **`~/.local/bin` tools have no recorded origin** (`rtk`, `memsearch`, `fireconnect`, `token-count`, ...). Decide which Lumen actually needs and script their install into `lumen-restore.sh`.
- **`lumen-restore.sh` untested end to end.** Best rehearsal: restore onto a second Mac or a fresh macOS user/VM with a different `$HOME`... which would break the identical-paths assumption, so realistically the wipe is the test. Keep the backup until Lumen replies.
- **Stale launchd jobs** (`com.nanoclaw-v2-1328e183`, `com.nanoclaw.statusbar`) point at the abandoned `~/Projects/nanoclaw`; unload and delete them on the live machine.
- **Hardened image needs a NanoClaw account**; the restore uses a local build instead. Revisit if the account path is wanted.
