# Dependency Snapshot Instructions

Use `scripts/dependency-check.sh` to capture dependency status once network access is available.

Recommended workflow:

1. Ensure you are on the target branch.
2. Run `scripts/dependency-check.sh > docs/wiki/dependencies/YYYY-MM-DD.md` (replace with the current date).
3. Summarize high-priority updates or vulnerabilities at the top of the generated file.
4. Commit the snapshot alongside any planned dependency upgrades.

> Note: The script will exit non-zero when network access is blocked; this placeholder exists so contributors know where to store future results.
