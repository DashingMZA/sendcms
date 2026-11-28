## What does this PR do?

<!-- Short description of the change and why it's needed. Link related issues: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / chore

## Checklist

<!-- Every command below exists in the root package.json and runs in
CI (see .github/workflows/ci.yml) — run them locally before pushing. -->

- [ ] Code typechecks (`pnpm typecheck` — turbo per-app typechecks + root `tsc --noEmit` + the workspace-import check)
- [ ] Lint is clean (`pnpm lint`)
- [ ] Formatted with Prettier (`pnpm format:check`)
- [ ] Translations validate (`pnpm validate:i18n`)
- [ ] Tests pass (`pnpm test`)
- [ ] Builds (`pnpm build`)
