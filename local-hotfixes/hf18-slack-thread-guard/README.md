# HF-18: local Slack session and thread guard

This standalone local plugin requests the persisted Slack peer, account,
and root policy for decodable Slack channel, group, and direct sessions
through the synchronous `outbound_route_decision` hook. Its callback reads the canonical session row
and returns a route request; it never acquires an outbound adapter, sends a
reply, or keeps a delivery ledger. The host independently validates the row
before taking custody. The message-tool guard enforces root sends when enabled,
and the per-run answer-repetition gate still suppresses immediate paraphrases.
The gate consumes the host's awaited, pre-model OpenClaw tool-result middleware
settlement (declared in the plugin manifest), not detached `after_tool_call` or
`message_sent` observations. A confirmed plain-text source send arms it before a
canonical final can be checked; a subsequent tool result advances it. The gate
is process-local and needs the canonical run ID and a settled Slack receipt;
missing settlement evidence does not suppress a final.
With `enforceRootDelivery: false`, same-surface finals keep their normal thread
policy. Cross-surface route requests fail closed: the host route contract cannot
redirect them without also forcing root delivery against that opt-out.
It imports only Node built-ins. The source is preserved for reapplication and
review, **not** registered as a bundled plugin or automatically installed.
Version 2.1.0 declares `openclaw.compat.pluginApi: >=2026.9.5`, but requires
the host-owned `outbound_route_decision` contract supplied by this HF-18 host
patch. An unpatched stock 2026.9.5 host admits the package by version but lacks
the contract: registration throws before any hooks are installed, rather than
silently leaving cross-surface delivery on its original route. Install the
plugin only alongside the patched host build; a plain stock install cannot
provide this behavior.

An ACP binding key such as `agent:codex:acp:binding:slack:default:<hash>`
does not encode its conversation target. A session row alone cannot prove the
target belongs to that configured binding; the pure route hook fails closed for
this key shape until the host supplies verified binding-to-route authority. The
message-tool guard retains its earlier persisted-row behavior, which is not
authority for the pure host route decision.

To reapply to a Gateway, the operator should copy this directory into its
local OpenClaw extension directory, preserve the installed config/consent,
and use the ordinary plugin lifecycle to enable and inspect it. Plugin
registration, capability consent, and Gateway restart/reload require the
operator's own approval. The audit-log default resolves under the current
user's home directory; configure `auditLog` explicitly to override it.

For offline proof run `node --test test/*.test.mjs` from this directory.
These tests prove plugin route intent, ordered gate decisions, and absence of
plugin-side sends, not actual host delivery. The host must call and validate the hook before both
direct and queued sends acquire custody, preserve the session-scoped media
loader, and fail closed on conflicts or timeout. Until that host integration
is installed, this plugin alone does **not** reroute cross-surface finals or
prevent source-surface delivery. `rerouteNonSlackDelivery: false` still opts
out of cross-surface route requests. The operator's `HOTFIXES.md` HF-18 entry
defines live routing and rollback acceptance.
