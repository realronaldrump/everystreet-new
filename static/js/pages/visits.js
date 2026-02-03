import initVisitsPage from "../modules/features/visits/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initVisitsPage, { route: "/visits" });
