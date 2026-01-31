import { onPageLoad } from "../modules/utils.js";
import initLandingPage from "../modules/features/landing/index.js";

onPageLoad(initLandingPage, { route: "/" });
