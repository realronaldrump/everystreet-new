import initTurnByTurnPage from "../modules/features/turn-by-turn/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initTurnByTurnPage, { route: "/turn-by-turn" });
