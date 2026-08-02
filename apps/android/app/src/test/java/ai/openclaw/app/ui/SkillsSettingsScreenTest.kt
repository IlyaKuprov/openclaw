package ai.openclaw.app.ui

import ai.openclaw.app.GatewayClawHubAcknowledgementKind
import org.junit.Assert.assertEquals
import org.junit.Test

class SkillsSettingsScreenTest {
  @Test
  fun installPolicyWarningShowsItsReasonBeforeAcknowledgement() {
    val notice =
      clawHubNoticeContent(
        rawText = "Review shell execution\n• [WARN · shell] Runs a shell",
        acknowledgementKind = GatewayClawHubAcknowledgementKind.INSTALL_POLICY,
        clawHubRiskSummary = "ClawHub release verification",
      )

    assertEquals("Review shell execution", notice.summary)
    assertEquals("• [WARN · shell] Runs a shell", notice.details)
  }

  @Test
  fun missingItemCopyHandlesZeroOneAndMany() {
    assertEquals("No missing items", skillMissingItemsText(0))
    assertEquals("1 missing item", skillMissingItemsText(1))
    assertEquals("2 missing items", skillMissingItemsText(2))
  }

  @Test
  fun missingSetupCopyUsesExplicitSingularAndPluralForms() {
    assertEquals(
      "This skill needs 1 setup item. Android shows what is installed; setup/config changes stay on desktop or CLI.",
      skillMissingConfigurationText(1),
    )
    assertEquals(
      "This skill needs 2 setup items. Android shows what is installed; setup/config changes stay on desktop or CLI.",
      skillMissingConfigurationText(2),
    )
  }
}
