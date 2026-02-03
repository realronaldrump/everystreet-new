import initExportPage from "../modules/features/export/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initExportPage, { route: "/export" });
