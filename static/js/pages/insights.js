import { onPageLoad } from "../modules/utils.js";
import initInsightsPage from "../modules/features/insights/index.js";

onPageLoad(initInsightsPage, { route: "/insights" });
