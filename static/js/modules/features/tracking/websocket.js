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

  if (typeof onOpen === "function") {
    socket.addEventListener("open", onOpen);
  }

  socket.addEventListener("message", (event) => {
    if (typeof onMessage !== "function") {
      return;
    }
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });

  socket.addEventListener("close", (event) => {
    if (typeof onClose === "function") {
      onClose(event);
    }
  });

  socket.addEventListener("error", (error) => {
    if (typeof onError === "function") {
      onError(error);
    }
  });

  return socket;
}
