import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

export function renderChatPanePlacement(props: {
  session: GatewaySessionRow | undefined;
  placementPlace?: string;
  placementGateway?: string;
  placementReclaimDisabledReason?: string;
  onPlacementReclaim?: () => void;
}): TemplateResult | typeof nothing {
  const placementState = props.session?.placement?.state;
  if (!isCloudWorkerPlacementState(placementState)) {
    return nothing;
  }
  const place = props.placementPlace ?? t("chat.sessionHeader.placement.cloud");
  const gateway = props.placementGateway ?? t("chat.sessionHeader.placement.gateway");
  const age = formatRelativeTimestamp(props.session?.placement?.stateChangedAtMs, {
    fallback: "",
  });
  return html`
    <wa-dropdown class="chat-pane__placement-menu" placement="bottom-start">
      <button
        slot="trigger"
        class="chat-pane__placement-chip"
        type="button"
        aria-label=${t("chat.sessionHeader.placement.onPlace", { place })}
      >
        ${t("chat.sessionHeader.placement.onPlace", { place })}
      </button>
      <div class="chat-pane__placement-state">${placementState}${age ? ` · ${age}` : ""}</div>
      <wa-dropdown-item
        class="chat-pane__placement-reclaim"
        ?disabled=${Boolean(props.placementReclaimDisabledReason)}
        title=${props.placementReclaimDisabledReason ?? nothing}
        @click=${() => !props.placementReclaimDisabledReason && props.onPlacementReclaim?.()}
      >
        ${t("chat.sessionHeader.placement.bringHome", { gateway })}
      </wa-dropdown-item>
      <div class="chat-pane__placement-note">${t("chat.sessionHeader.placement.note")}</div>
    </wa-dropdown>
  `;
}
