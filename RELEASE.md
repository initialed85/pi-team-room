# Release checklist

1. Run `npm test`.
2. Review `git diff` and update `CHANGELOG.md`.
3. Bump `version` in `package.json` using semantic versioning.
4. Commit the release changes.
5. Create an annotated tag matching the package version, for example `git tag -a v0.1.0 -m "Pi Team Room 0.1.0"`.
6. Push the branch and tag to the configured Git remote.
7. On each host, run `git pull --ff-only` in the checkout and restart Pi sessions.

Pi loads local path packages directly, so reinstalling is not necessary after a normal pull. Run `pi install ~/Projects/Home/pi-team-room` once on a host to add the checkout to Pi settings.
