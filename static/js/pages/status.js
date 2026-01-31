import { onPageLoad } from "../modules/utils.js";
import initStatusPage from "../modules/features/status/index.js";

onPageLoad(initStatusPage, { route: "/status" });
