import initStatusPage from "../modules/features/status/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initStatusPage, { route: "/status" });
