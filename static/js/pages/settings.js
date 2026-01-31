import { onPageLoad } from "../modules/utils.js";
import initSettingsPage from "../modules/features/settings/index.js";

onPageLoad(initSettingsPage, { route: "/settings" });
