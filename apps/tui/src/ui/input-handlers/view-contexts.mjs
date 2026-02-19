export function handleContextsViewInput({ input, key, actions }) {
  if (key.upArrow) {
    actions.moveResume(-1);
    return true;
  }
  if (key.downArrow) {
    actions.moveResume(1);
    return true;
  }
  if (input === "r") {
    actions.refreshResume();
    return true;
  }
  if (key.return || input === " ") {
    actions.promptResumeTarget();
    return true;
  }
  return false;
}
