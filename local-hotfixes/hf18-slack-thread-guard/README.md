# HF-18: local Slack session and thread guard

This is the standalone 2.0.5 local plugin used by the operator's 2026.9.5
Gateway. It confines Slack-named sessions to their persisted Slack channel
and channel-root delivery, while rejecting cross-surface reply leakage and
unproven duplicate final replies. It imports only Node built-ins. The source
is preserved here for reapplication and review, **not** registered as a
bundled plugin or automatically installed by this PR.

To reapply to a Gateway, the operator should copy this directory into its
local OpenClaw extension directory, preserve the installed config/consent,
and use the ordinary plugin lifecycle to enable and inspect it. Plugin
registration, capability consent, and Gateway restart/reload require the
operator's own approval. The audit-log default resolves under the current
user's home directory; configure `auditLog` explicitly to override it.

For offline proof run `node --test test/*.test.mjs` from this directory.
The operator's `HOTFIXES.md` HF-18 entry defines the live routing and
rollback acceptance conditions. This fork-only PR does not alter core Slack
handling or a running Gateway.
