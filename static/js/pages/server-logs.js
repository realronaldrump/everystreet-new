import { onPageLoad } from "../modules/utils.js";
import initServerLogsPage from "../modules/features/server-logs/index.js";

onPageLoad(initServerLogsPage, { route: "/server-logs" });
