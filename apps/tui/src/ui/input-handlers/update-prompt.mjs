export function handleUpdatePromptInput({ input, key, actions, snapshot }) {
  if (key.upArrow) {
    actions.moveUpdatePrompt?.(-1);
    return;
  }
  if (key.downArrow) {
    actions.moveUpdatePrompt?.(1);
    return;
  }
  if (input === "1" || input === "2") {
    actions.chooseUpdatePrompt?.(Number(input) - 1);
    return;
  }
  if (key.return || input === " ") {
    actions.chooseUpdatePrompt?.(snapshot.updatePrompt?.selectedIndex ?? 0);
  }
}
