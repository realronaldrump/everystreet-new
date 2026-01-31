import { onPageLoad } from "../modules/utils.js";
import initCoverageManagementPage from "../modules/features/coverage-management/index.js";

onPageLoad(initCoverageManagementPage, { route: "/coverage-management" });
