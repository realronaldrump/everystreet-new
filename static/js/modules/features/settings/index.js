import { initAppSettings } from "./app-settings.js";
import initControlCenterOverview from "./control-center-overview.js";
import { setupCredentialsSettings } from "./credentials-settings.js";

export default function initSettingsPage({ signal, cleanup } = {}) {
  initAppSettings({ signal });
  initControlCenterOverview({ signal, cleanup });
  setupCredentialsSettings({ signal });
}
