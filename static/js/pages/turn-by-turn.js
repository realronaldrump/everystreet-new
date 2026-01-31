import { onPageLoad } from "../modules/utils.js";
import initTurnByTurnPage from "../modules/features/turn-by-turn/index.js";

onPageLoad(initTurnByTurnPage, { route: "/turn-by-turn" });
