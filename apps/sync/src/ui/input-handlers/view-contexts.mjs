export function handleContextsViewInput({ input, key, actions, snapshot }) {
  const detailActive = snapshot?.detailView?.active;

  // ── detail mode ───────────────────────────────────────────────
  if (detailActive) {
    if (key.escape || key.leftArrow) {
      actions.closeDetail();
      return true;
    }
    if (key.upArrow) {
      actions.scrollDetail(-1);
      return true;
    }
    if (key.downArrow) {
      actions.scrollDetail(1);
      return true;
    }
    if (input === "j") {
      actions.scrollDetailLine(1);
      return true;
    }
    if (input === "k") {
      actions.scrollDetailLine(-1);
      return true;
    }
    if (input === "r") {
      actions.refreshDetail();
      return true;
    }
    return true;
  }

  // ── list mode ─────────────────────────────────────────────────
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
    actions.enterContext();
    return true;
  }
  return false;
}
