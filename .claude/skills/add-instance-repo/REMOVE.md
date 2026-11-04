# Remove Instance Repo

Takes the checkout back to a single repo. **Your private data is not deleted**: it stays in the instance
repo until you move it yourself.

## 1. Bring the data back into the checkout (only if you want it there)

```bash
for n in groups host-shims mcp-shims; do
  rm "$n"                       # removes the symlink only, never the target
  mkdir "$n"
  cp -a "$NANOCLAW_INSTANCE_REPO/$n/." "$n/"
done
```

(Skip this if you are retiring the install; just `rm` the three symlinks.)

## 2. Remove the hooks' instance parts

```bash
# the marked block in pre-commit
sed -i.bak '/>>> instance-repo/,/<<< instance-repo/d' .husky/pre-commit && rm -f .husky/pre-commit.bak
# post-commit / post-checkout were installed whole by this skill; delete them if you have not added your own code
git rm -f .husky/post-commit .husky/post-checkout .husky/_/post-checkout 2>/dev/null || rm -f .husky/post-commit .husky/post-checkout
rm -f "$NANOCLAW_INSTANCE_REPO/.git/hooks/post-commit"      # the DB-snapshot hook
```

## 3. `.gitignore`

Remove the `/mcp-shims/` and `/host-shims/` lines (and `groups/*` if you want `groups/` tracked) and the
`add-instance-repo` comment above them.

## 4. Recipe entry

```bash
sed -i.bak '/add-instance-repo/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

`~/nanoclaw-db-backups/` is left alone.
