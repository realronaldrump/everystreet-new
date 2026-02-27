export function connectLiveWebSocket({
  onMessage,
  onOpen,
  onClose,
  onError,
  path = "/ws/trips",
} = {}) {
  if (!("WebSocket" in window)) {
    return null;
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${path}`;
  let socket = null;

  try {
    socket = new WebSocket(url);
  } catch (error) {
    if (typeof onError === "function") {
      onError(error);
    }
    return null;
  }

  const openHandler = typeof onOpen === "function" ? onOpen : null;

  const messageHandler = (event) => {
    if (typeof onMessage !== "function") {
      return;
    }
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  };

  const closeHandler = (event) => {
    if (typeof onClose === "function") {
      onClose(event);
    }
  };

  const errorHandler = (error) => {
    if (typeof onError === "function") {
      onError(error);
    }
  };

  if (openHandler) {
    socket.addEventListener("open", openHandler);
  }
  socket.addEventListener("message", messageHandler);
  socket.addEventListener("close", closeHandler);
  socket.addEventListener("error", errorHandler);

  socket.cleanup = () => {
    if (openHandler) {
      socket.removeEventListener("open", openHandler);
    }
    socket.removeEventListener("message", messageHandler);
    socket.removeEventListener("close", closeHandler);
    socket.removeEventListener("error", errorHandler);
  };

  return socket;
}
