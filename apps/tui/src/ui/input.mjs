import {
  handleBootstrapInput,
  buildMoveMenuIndex,
  handleMenuInput,
  handleResumeTargetInput,
  handleUpdatePromptInput,
  handleViewInput,
  isQuitInput,
} from "./input-handlers/index.mjs";

export { buildMoveMenuIndex } from "./input-handlers/index.mjs";

export function createInputHandler({
  snapshot,
  actions,
  focusMode,
  menuIndex,
  selectedTabIndex,
  setFocusMode,
  setMenuIndex,
  moveMenuIndex,
  bootstrapActive,
  updatePromptActive,
  resumeTargetPickerActive,
}) {
  return (input, key) => {
    if (isQuitInput(input, key)) {
      actions.stop();
      return;
    }

    // update prompt has highest priority
    if (updatePromptActive) {
      handleUpdatePromptInput({ input, key, actions, snapshot });
      return;
    }
    if (bootstrapActive) {
      handleBootstrapInput({ input, key, actions, snapshot });
      return;
    }
    if (resumeTargetPickerActive) {
      handleResumeTargetInput({ input, key, actions, snapshot });
      return;
    }
    if (focusMode === "menu") {
      handleMenuInput({ input, key, actions, menuIndex, setFocusMode, moveMenuIndex });
      return;
    }

    handleViewInput({
      input,
      key,
      actions,
      snapshot,
      selectedTabIndex,
      setFocusMode,
      setMenuIndex,
    });
  };
}
