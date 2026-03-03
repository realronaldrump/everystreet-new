export default function initProfilePage({ cleanup } = {}) {
  const teardown = () => {};
  if (typeof cleanup === "function") {
    cleanup(teardown);
  }
  return teardown;
}
