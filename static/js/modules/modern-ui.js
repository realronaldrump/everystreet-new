// Modern-UI shim for ES modules

if (!window.modernUI) {
  await import('../modern-ui.js');
}

export default window.modernUI; 