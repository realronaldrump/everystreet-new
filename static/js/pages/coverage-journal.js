import bootstrapPage from "../modules/core/page-bootstrap.js";
import initCoverageJournalPage from "../modules/features/coverage-journal/index.js";

bootstrapPage(initCoverageJournalPage, /^\/coverage-management\/[^/]+\/journal$/);
