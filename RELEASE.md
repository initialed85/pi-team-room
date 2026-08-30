# Release checklist

1. Run `npm test`.
2. Review `git diff` and update `CHANGELOG.md`.
3. Bump `version` in `package.json` using semantic versioning.
4. Commit the release changes.
5. Create an annotated tag matching the package version, for example `git tag -a vX.Y.Z -m "Pi Team Room X.Y.Z"`.
6. Push the current branch and tag to the configured Git remote with `git push origin HEAD --tags`.
7. On each host, run `git pull --ff-only` in the checkout and restart Pi sessions.

Pi loads local path packages directly, so reinstalling is not necessary after a normal pull. Run `pi install ~/Projects/Home/pi-team-room` once on a host to add the checkout to Pi settings.
