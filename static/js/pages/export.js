import { onPageLoad } from "../modules/utils.js";
import initExportPage from "../modules/features/export/index.js";

onPageLoad(initExportPage, { route: "/export" });
