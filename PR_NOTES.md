# PR Notes

- Treat `contentDriftedFiles` as freshness risk across MCP read-tool gating, auto-sync, structured freshness metadata, and empty-result hints. Clean-git disk/index content drift now recommends or performs sync instead of reporting a false true negative.
