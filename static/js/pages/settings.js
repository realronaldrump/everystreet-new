import initSettingsPage from "../modules/features/settings/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initSettingsPage, { route: "/settings" });
