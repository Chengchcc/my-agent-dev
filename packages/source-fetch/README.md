# @chengchenccc/source-fetch

Shared mechanical capability for materializing external sources onto disk:
git clone/checkout, zip extraction, and directory fingerprinting. No business
semantics, no backend/oma coupling — consumed by both `apps/backend` skill-pack
and `apps/oh-my-agent` plugin marketplace.

## API

- `fetchGitSource({ url, dataDir, ref?, slug? }) → { root, rev }`
- `materializeZipSource({ buffer, dataDir, slug }) → { root, rev }`
- `directoryFingerprint(dir) → "sha256:..."`
- `validateExtractedEntries(root, dir)` — symlink/path-escape guard
