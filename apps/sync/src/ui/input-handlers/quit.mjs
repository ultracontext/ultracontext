export function isQuitInput(input, key) {
  return (key.ctrl && input === "c") || input === "\u0003" || input === "q" || input === "Q";
}
