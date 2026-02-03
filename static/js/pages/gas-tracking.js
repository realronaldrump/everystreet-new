import initGasTrackingPage from "../modules/features/gas-tracking/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initGasTrackingPage, { route: "/gas-tracking" });
