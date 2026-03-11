/**
 * Progress Card Generator
 *
 * Generates beautiful shareable progress cards as downloadable PNG images
 * using canvas rendering (no external dependencies).
 */

class ProgressCardGenerator {
  /**
   * Generate a shareable progress card image.
   * @param {Object} data - Card data
   * @param {string} data.areaName - Coverage area name
   * @param {number} data.coveragePercent - Coverage percentage
   * @param {number} data.milesDriven - Total miles driven
   * @param {number} data.areaMiles - Total drivable miles in the area
   * @param {number} data.totalTrips - Total trip count
   * @param {number} data.streetsDriven - Number of driven streets
   * @param {number} data.totalStreets - Total streets in area
   * @param {string} data.dateRange - Date range string
   * @returns {Promise<Blob>} PNG image blob
   */
  async generateCard(data) {
    const width = 800;
    const height = 480;
    const canvas = document.createElement("canvas");
    canvas.width = width * 2; // 2x for retina
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, "#0a0a0c");
    bgGrad.addColorStop(0.5, "#111114");
    bgGrad.addColorStop(1, "#0d0d10");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Subtle pattern overlay
    ctx.globalAlpha = 0.03;
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.random() * width, Math.random() * height, 1, 1);
    }
    ctx.globalAlpha = 1;

    // Accent stripe at top
    const accentGrad = ctx.createLinearGradient(0, 0, width, 0);
    accentGrad.addColorStop(0, "#3b8a7f");
    accentGrad.addColorStop(1, "#d09868");
    ctx.fillStyle = accentGrad;
    ctx.fillRect(0, 0, width, 4);

    // Brand
    ctx.font = "600 14px 'Chivo', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.textAlign = "right";
    ctx.fillText("everystreet.me", width - 40, 36);

    // Area name
    ctx.textAlign = "left";
    ctx.font = "700 32px 'Chivo', sans-serif";
    ctx.fillStyle = "#f5f2ec";
    ctx.fillText(data.areaName || "My Coverage", 40, 72);

    // Date range
    ctx.font = "400 14px 'IBM Plex Sans', sans-serif";
    ctx.fillStyle = "rgba(245, 242, 236, 0.5)";
    if (data.dateRange) ctx.fillText(data.dateRange, 40, 96);

    // Coverage ring
    const ringX = 160;
    const ringY = 240;
    const ringR = 80;
    const percent = data.coveragePercent || 0;

    // Ring background
    ctx.beginPath();
    ctx.arc(ringX, ringY, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 12;
    ctx.stroke();

    // Ring fill
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + (percent / 100) * Math.PI * 2;
    const ringGrad = ctx.createLinearGradient(ringX - ringR, ringY, ringX + ringR, ringY);
    ringGrad.addColorStop(0, "#3b8a7f");
    ringGrad.addColorStop(1, "#4d9a6a");
    ctx.beginPath();
    ctx.arc(ringX, ringY, ringR, startAngle, endAngle);
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.stroke();

    // Percentage text
    ctx.textAlign = "center";
    ctx.font = "700 42px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#f5f2ec";
    ctx.fillText(`${percent.toFixed(1)}%`, ringX, ringY + 8);
    ctx.font = "500 14px 'IBM Plex Sans', sans-serif";
    ctx.fillStyle = "rgba(245, 242, 236, 0.6)";
    ctx.fillText("covered", ringX, ringY + 30);

    // Stats on the right
    const statsX = 360;
    const statsStartY = 170;
    const milesDriven = this._firstFinite(data.milesDriven, data.totalMiles, 0);
    const areaMiles = this._firstFinite(data.areaMiles, data.totalAreaMiles, null);
    const totalTrips = this._firstFinite(data.totalTrips, null);
    const streetsDriven = this._firstFinite(data.streetsDriven, data.drivenStreets, 0);
    const totalStreets = this._firstFinite(data.totalStreets, 0);
    const stats = [
      { label: "Miles Driven", value: this._formatNumber(milesDriven, 1), unit: "mi" },
      totalTrips > 0
        ? { label: "Total Trips", value: this._formatNumber(totalTrips), unit: "" }
        : {
            label: "Area Miles",
            value: this._formatNumber(areaMiles || 0, 1),
            unit: "mi",
          },
      {
        label: "Streets Driven",
        value: `${streetsDriven} / ${totalStreets}`,
        unit: "",
      },
    ];

    stats.forEach((stat, i) => {
      const y = statsStartY + i * 70;

      ctx.textAlign = "left";
      ctx.font = "500 13px 'IBM Plex Sans', sans-serif";
      ctx.fillStyle = "rgba(245, 242, 236, 0.45)";
      ctx.fillText(stat.label, statsX, y);

      ctx.font = "700 28px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#f5f2ec";
      const valueText = stat.unit ? `${stat.value} ${stat.unit}` : stat.value;
      ctx.fillText(valueText, statsX, y + 28);

      // Subtle separator
      if (i < stats.length - 1) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(statsX, y + 44, 340, 1);
      }
    });

    // Bottom border glow
    const bottomGrad = ctx.createLinearGradient(0, height - 3, 0, height);
    bottomGrad.addColorStop(0, "rgba(59, 138, 127, 0.3)");
    bottomGrad.addColorStop(1, "rgba(59, 138, 127, 0)");
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, height - 3, width, 3);

    return new Promise((resolve) => {
      canvas.toBlob(resolve, "image/png", 1.0);
    });
  }

  /**
   * Generate and download a progress card.
   * @param {Object} data - Card data (same as generateCard)
   * @param {string} filename - Download filename
   */
  async downloadCard(data, filename = "everystreet-progress.png") {
    const blob = await this.generateCard(data);
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Generate and copy to clipboard.
   * @param {Object} data - Card data
   */
  async copyCardToClipboard(data) {
    const blob = await this.generateCard(data);
    if (!blob) return false;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  _formatNumber(num, decimals = 0) {
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  _firstFinite(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === "") {
        continue;
      }
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
    return 0;
  }
}

const progressCardGenerator = new ProgressCardGenerator();
export default progressCardGenerator;
