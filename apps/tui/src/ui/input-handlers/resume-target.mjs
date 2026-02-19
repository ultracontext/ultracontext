export function handleResumeTargetInput({ input, key, actions, snapshot }) {
  if (key.upArrow) {
    actions.moveResumeTarget?.(-1);
    return;
  }
  if (key.downArrow) {
    actions.moveResumeTarget?.(1);
    return;
  }
  if (input === "1" || input === "2") {
    actions.chooseResumeTarget?.(Number(input) - 1);
    return;
  }
  if (key.leftArrow || key.escape) {
    actions.cancelResumeTarget?.();
    return;
  }
  if (key.return || input === " ") {
    actions.chooseResumeTarget?.(snapshot.resumeTargetPicker?.selectedIndex ?? 0);
  }
}
