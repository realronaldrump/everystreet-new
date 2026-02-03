import initServerLogsPage from "../modules/features/server-logs/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initServerLogsPage, { route: "/server-logs" });
