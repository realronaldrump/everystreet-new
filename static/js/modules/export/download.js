/**
 * Export Download Handler
 * Manages file downloads with streaming and progress tracking
 */

import { getContentTypeForFormat, getFilenameFromHeaders } from "./format-utils.js";

/**
 * Download a file from a URL with progress tracking
 * @param {string} url - URL to download from
 * @param {string} exportName - Name of the export for display
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<void>}
 */
export async function downloadFile(url, exportName, signal) {
  const urlWithTimestamp = `${url}${url.includes("?") ? "&" : "?"}timestamp=${Date.now()}`;

  try {
    window.notificationManager?.show(`Requesting ${exportName} data...`, "info");
    console.info(`Requesting export from: ${urlWithTimestamp}`);
    window.loadingManager?.show(exportName);

    const fetchOptions = { signal };
    console.info(`Starting fetch for ${exportName} export...`);
    const response = await fetch(urlWithTimestamp, fetchOptions);
    console.info(`Received response: status=${response.status}, ok=${response.ok}`);

    // Check for Content-Disposition header to identify file downloads
    const contentDisposition = response.headers.get("Content-Disposition");
    const isFileDownload = contentDisposition?.includes("attachment");

    // Only throw an error if response is not ok AND it's not a file download
    if (!response.ok && !isFileDownload) {
      let errorMsg = `Server error (${response.status})`;
      try {
        const errorText = await response.text();
        console.error(`Server error details for ${exportName}: ${errorText}`);
        if (errorText) {
          try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.detail || errorJson.message || errorText;
          } catch {
            errorMsg = errorText.substring(0, 100);
          }
        }
      } catch {
        // ignore
      }
      throw new Error(errorMsg);
    }

    // If it's a file download or response.ok is true, proceed with download logic
    const contentLength = response.headers.get("Content-Length");
    const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
    console.info(`Content-Length: ${contentLength}, parsed size: ${totalSize}`);
    console.info("Response headers:");
    response.headers.forEach((value, name) => {
      console.info(`${name}: ${value}`);
    });

    const formatMatch = urlWithTimestamp.match(/format=([^&]+)/);
    const format = formatMatch ? formatMatch[1] : null;
    const filename = getFilenameFromHeaders(contentDisposition, exportName, format);

    window.notificationManager?.show(`Downloading ${filename}...`, "info");
    console.info(`Starting download of ${filename}...`);

    await processDownloadStream(response, filename, format, totalSize);
  } catch (error) {
    console.error(`Export error for ${exportName}:`, error);
    if (error.name === "AbortError") {
      throw new Error(
        "Export timed out. The file might be too large or the server is busy."
      );
    }
    const errorMsg = `Export failed: ${error.message || "Unknown error"}`;
    window.notificationManager?.show(errorMsg, "error");
    throw error;
  } finally {
    window.loadingManager?.hide();
  }
}

/**
 * Process the download stream with progress tracking
 * @param {Response} response - Fetch response object
 * @param {string} filename - Filename for the download
 * @param {string} format - Export format
 * @param {number} totalSize - Total size in bytes (0 if unknown)
 * @returns {Promise<void>}
 */
async function processDownloadStream(response, filename, format, totalSize) {
  const reader = response.body.getReader();
  let receivedLength = 0;
  const chunks = [];
  let reading = true;

  while (reading) {
    const { done, value } = await reader.read();

    if (done) {
      reading = false;
      console.info(
        `Finished reading response body, total size: ${receivedLength} bytes`
      );
      break;
    }

    chunks.push(value);
    receivedLength += value.length;

    // Log progress periodically
    if (
      totalSize &&
      receivedLength % Math.max(totalSize / 10, 1024 * 1024) < value.length
    ) {
      console.info(
        `Download progress: ${Math.round((receivedLength / totalSize) * 100)}% (${receivedLength}/${totalSize} bytes)`
      );
    }

    // Update progress indicator
    if (totalSize) {
      updateProgress(receivedLength, totalSize);
    }
  }

  console.info(`Combining ${chunks.length} chunks into final blob...`);
  const chunksAll = new Uint8Array(receivedLength);
  let position = 0;
  for (const chunk of chunks) {
    chunksAll.set(chunk, position);
    position += chunk.length;
  }

  const contentType = getContentTypeForFormat(format);
  console.info(`Creating blob with type: ${contentType}`);
  const blob = new Blob([chunksAll], { type: contentType });

  triggerDownload(blob, filename, contentType);
  window.notificationManager?.show(`Successfully exported ${filename}`, "success");
}

/**
 * Update progress indicators
 * @param {number} receivedLength - Bytes received so far
 * @param {number} totalSize - Total size in bytes
 */
function updateProgress(receivedLength, totalSize) {
  const progress = Math.min(Math.round((receivedLength / totalSize) * 100), 100);

  if (
    window.loadingManager &&
    typeof window.loadingManager.updateProgress === "function"
  ) {
    window.loadingManager.updateProgress(progress);
  } else if (
    window.LoadingManager &&
    typeof window.LoadingManager.updateProgress === "function"
  ) {
    window.LoadingManager.updateProgress(progress);
  } else {
    const progressBar = document.getElementById("loading-progress-bar");
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
  }
}

/**
 * Trigger a file download from a blob
 * @param {Blob} blob - Blob to download
 * @param {string} filename - Filename for the download
 * @param {string} contentType - MIME content type
 */
export function triggerDownload(blob, filename, contentType) {
  const blobUrl = URL.createObjectURL(blob);
  console.info(`Blob URL created: ${blobUrl.substring(0, 30)}...`);
  console.info(`Triggering download of ${filename}`);

  const downloadLink = document.createElement("a");
  downloadLink.style.display = "none";
  downloadLink.href = blobUrl;
  downloadLink.download = filename;

  if ("download" in downloadLink) {
    downloadLink.type = contentType;
  }

  document.body.appendChild(downloadLink);
  downloadLink.click();

  setTimeout(() => {
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(blobUrl);
    console.info(`Download cleanup completed for ${filename}`);
  }, 100);
}

export default {
  downloadFile,
  triggerDownload,
};
