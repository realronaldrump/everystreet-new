export function createCoordinateBounds(nativeBounds = null) {
  if (
    nativeBounds &&
    typeof nativeBounds.extend === "function" &&
    typeof nativeBounds.isEmpty === "function"
  ) {
    return {
      extend(coord) {
        nativeBounds.extend(coord);
      },
      isEmpty() {
        return nativeBounds.isEmpty();
      },
      toValue() {
        return nativeBounds;
      },
    };
  }

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  return {
    extend(coord) {
      if (!Array.isArray(coord) || coord.length < 2) {
        return;
      }
      const lng = Number(coord[0]);
      const lat = Number(coord[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return;
      }
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
    },
    isEmpty() {
      return !(
        Number.isFinite(minLng) &&
        Number.isFinite(minLat) &&
        Number.isFinite(maxLng) &&
        Number.isFinite(maxLat)
      );
    },
    toValue() {
      if (this.isEmpty()) {
        return null;
      }
      return [
        [minLng, minLat],
        [maxLng, maxLat],
      ];
    },
  };
}
