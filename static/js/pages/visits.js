import { onPageLoad } from "../modules/utils.js";
import initVisitsPage from "../modules/features/visits/index.js";

onPageLoad(initVisitsPage, { route: "/visits" });
