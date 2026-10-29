# Release checklist

1. Run `npm test`.
2. Review `git diff` and update `CHANGELOG.md`.
3. Bump `version` in `package.json` using semantic versioning.
4. Commit the release changes.
5. Create an annotated tag matching the package version, for example `git tag -a vX.Y.Z -m "Pi Team Room X.Y.Z"`. Verify the two agree before tagging: `node -e 'process.stdout.write(require("./package.json").version)'` must print the same `X.Y.Z` as `git tag --points-at HEAD`. `v0.1.1` was tagged while the manifest still read `0.1.0`, which left the tag and the package claiming different versions.
6. Push the current branch and tag to the configured Git remote with `git push origin HEAD --tags`.
7. On each host, run `git pull --ff-only` in the checkout and restart Pi sessions.

Pi loads local path packages directly, so reinstalling is not necessary after a normal pull. Run `pi install ~/Projects/Home/pi-team-room` once on a host to add the checkout to Pi settings.
