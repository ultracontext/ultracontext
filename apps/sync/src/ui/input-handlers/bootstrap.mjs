export function handleBootstrapInput({ input, key, actions, snapshot }) {
  if (key.upArrow) {
    actions.moveBootstrap?.(-1);
    return;
  }
  if (key.downArrow) {
    actions.moveBootstrap?.(1);
    return;
  }
  if (input === "1" || input === "2" || input === "3") {
    actions.chooseBootstrap?.(Number(input) - 1);
    return;
  }
  if (key.return || input === " ") {
    actions.chooseBootstrap?.(snapshot.bootstrap?.selectedIndex ?? 0);
  }
}
