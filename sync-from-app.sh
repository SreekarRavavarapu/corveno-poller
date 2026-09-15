#!/usr/bin/env bash
# Copy the canonical collector from the Corveno app repository into src/ and
# rewrite its lib imports to sibling modules so esbuild can bundle it. Run
# `npm run build` afterwards and commit dist/run.cjs with the source.
set -euo pipefail
APP="${CORVENO_APP_DIR:-$HOME/Corveno}"
mkdir -p src
cp "$APP/scripts/corpus/run.ts" src/run.ts
cp "$APP/scripts/corpus/primary-source.ts" src/primary-source.ts
# Only modules the collector imports (transitively). Extend when run.ts grows.
for f in country-evidence employment-evidence ${EXTRA_MODULES:-}; do
  if [ -f "$APP/lib/corpus/$f.ts" ]; then cp "$APP/lib/corpus/$f.ts" "src/$f.ts"; fi
done
# ../../lib/corpus/<module> → ./<module>
sed -i '' -E 's#"\.\./\.\./lib/corpus/([a-z-]+)"#"./\1"#g' src/*.ts
echo "synced from $APP:"; ls -1 src
