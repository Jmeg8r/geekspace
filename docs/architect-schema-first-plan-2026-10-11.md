# Require schema discovery before MCP writes

An isolated ARCHITECT trial created a page through the real MCP server before calling query_schema. The server instructs clients to read schema first, but previously did not enforce that prerequisite.

The MCP session now refuses every modifying tool until query_schema succeeds. Read-only tools remain available. Failed schema refreshes close the write gate until a subsequent successful read. New modifying tools inherit this default; only the named read-only operations bypass it. This is a session prerequisite, not a claim that a particular model understood the schema.

The change affects only mcp/index.mjs, its stdio protocol tests and this plan. Open PR 28 overlaps mcp/index.mjs with unrelated property/date validation and formatting changes; those edits remain on their branch. The current base is 5585e74 and no intervening main commit changed the MCP implementation.

Verify all eight write tools refuse before a backend mutation, a successful schema read enables a write, other reads cannot enable writes, a failed refresh closes the gate, and separate sessions do not share discovery. Then exercise the real server against a new empty local Convex deployment with synthetic data and confirm owned-process/listener closure. Run the full repository verification and production build.

The user's active Geekspace checkout and workspace stay unchanged. Rollback is reverting this PR before a later deployment. Bulk-change confirmation, model-driven workflow success and secure native/OpenShell composition remain separate qualification steps.
