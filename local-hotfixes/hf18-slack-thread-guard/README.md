# HF-18: local Slack session and thread guard

This standalone local plugin requests the persisted Slack channel, account,
and channel-root policy for Slack channel sessions through the synchronous
`outbound_route_decision` hook. Its callback reads the canonical session row
and returns a route request; it never acquires an outbound adapter, sends a
reply, or keeps a delivery ledger. The host independently validates the row
before taking custody. The message-tool guard still enforces root sends and
the per-run answer-repetition gate still suppresses immediate paraphrases.
It imports only Node built-ins. The source is preserved for reapplication and
review, **not** registered as a bundled plugin or automatically installed.

To reapply to a Gateway, the operator should copy this directory into its
local OpenClaw extension directory, preserve the installed config/consent,
and use the ordinary plugin lifecycle to enable and inspect it. Plugin
registration, capability consent, and Gateway restart/reload require the
operator's own approval. The audit-log default resolves under the current
user's home directory; configure `auditLog` explicitly to override it.

For offline proof run `node --test test/*.test.mjs` from this directory.
These tests prove plugin route intent and absence of plugin-side sends, not
actual host delivery. The host must call and validate the hook before both
direct and queued sends acquire custody, preserve the session-scoped media
loader, and fail closed on conflicts or timeout. Until that host integration
is installed, this plugin alone does **not** reroute cross-surface finals or
prevent source-surface delivery. `rerouteNonSlackDelivery: false` still opts
out of cross-surface route requests. The operator's `HOTFIXES.md` HF-18 entry
defines live routing and rollback acceptance.
