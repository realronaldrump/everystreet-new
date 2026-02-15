import { buildTurnByTurnUrl } from "../turn-by-turn/turn-by-turn-api.js";

export function buildTurnByTurnLaunchUrl(areaId, activeMission = null) {
  const missionStatus = String(activeMission?.status || "").toLowerCase();
  const canResumeMission =
    activeMission?.id &&
    (missionStatus === "active" || missionStatus === "paused") &&
    String(activeMission?.area_id || "") === String(areaId);

  return buildTurnByTurnUrl({
    areaId,
    missionId: canResumeMission ? activeMission.id : null,
    autoStart: Boolean(canResumeMission),
  });
}
