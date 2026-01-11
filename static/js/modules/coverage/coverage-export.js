/**
 * Coverage Export
 * Handles exporting the coverage map to an image
 */
import dateUtils from "../date-utils.js";

/* global html2canvas */

export class CoverageExport {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
  }

  /**
   * Export coverage map
   * @param {Object} selectedLocation - The currently selected location object
   */
  exportCoverageMap(selectedLocation) {
    const mapContainer = document.getElementById("coverage-map");
    // Note: We check if the container exists. The caller should ensure the map is ready.
    if (!mapContainer) {
      this.notificationManager.show("Map container not found.", "warning");
      return;
    }
    this.notificationManager.show("Preparing map export...", "info");

    const doExport = () => {
      setTimeout(() => {
        html2canvas(mapContainer, {
          useCORS: true,
          backgroundColor: "#1e1e1e",
          logging: false,
          allowTaint: true,
          width: mapContainer.offsetWidth,
          height: mapContainer.offsetHeight,
        })
          .then((canvas) => {
            canvas.toBlob((blob) => {
              if (!blob) {
                this.notificationManager.show(
                  "Failed to create image blob.",
                  "danger",
                );
                return;
              }
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              const locationName =
                selectedLocation?.location?.display_name || "coverage_map";
              const dateStr = dateUtils.formatDateToString(new Date());
              a.download = `${locationName
                .replace(/[^a-z0-9]/gi, "_")
                .toLowerCase()}_${dateStr}.png`;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this.notificationManager.show("Map exported.", "success");
              }, 100);
            }, "image/png");
          })
          .catch((error) => {
            console.error("html2canvas export error:", error);
            this.notificationManager.show(
              `Map export failed: ${error.message}`,
              "danger",
            );
          });
      }, 500);
    };

    if (typeof html2canvas === "undefined") {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      script.integrity =
        "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==";
      script.crossOrigin = "anonymous";
      script.onload = doExport;
      script.onerror = () =>
        this.notificationManager.show(
          "Failed to load export library.",
          "danger",
        );
      document.head.appendChild(script);
    } else {
      doExport();
    }
  }
}
