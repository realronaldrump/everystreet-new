import { onPageLoad } from "../modules/utils.js";
import initCoverageNavigatorPage from "../modules/features/coverage-navigator/index.js";

onPageLoad(initCoverageNavigatorPage, { route: "/coverage-navigator" });
