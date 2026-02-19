export function handleConfigsViewInput({ input, key, actions }) {
  if (key.upArrow) {
    actions.moveConfig(-1);
    return true;
  }
  if (key.downArrow) {
    actions.moveConfig(1);
    return true;
  }
  if (key.return || key.rightArrow || input === " ") {
    actions.toggleConfig();
    return true;
  }
  return false;
}
