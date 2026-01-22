import { initDatabaseManagement } from "../database-management.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initDatabaseManagement, { route: "/database-management" });
