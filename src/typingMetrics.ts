// Counters behind an answer's typing record, folded from the browser's `beforeinput` events
// (fired before the text changes, so the selection is still the one the edit acts on).

export interface TypingMetrics {
  /** Characters typed. */
  typed: number;
  /** Operations that changed already-written text: deletes, replacing a selection, inserting mid-text, undo/redo. */
  edited: number;
  /** Characters pasted (or dropped) in. */
  pasted: number;
  /** Delete operations specifically (a subset of `edited`). */
  deleted: number;
  /** Active typing time; a pause longer than {@link IDLE_GAP_MS} doesn't count. */
  typingMs: number;
  /** Pauses longer than {@link FREEZE_GAP_MS} between two inputs. */
  freezeCount: number;
  /** The longest such pause, in ms. */
  longestFreezeMs: number;
}

export const IDLE_GAP_MS = 5000;
export const FREEZE_GAP_MS = 15000;

export const emptyMetrics = (): TypingMetrics => ({
  typed: 0,
  edited: 0,
  pasted: 0,
  deleted: 0,
  typingMs: 0,
  freezeCount: 0,
  longestFreezeMs: 0,
});

export interface InputContext {
  inputType: string;
  /** The text being inserted, when the event carries any. */
  data: string | null;
  selectionStart: number;
  selectionEnd: number;
  valueLength: number;
  now: number;
  /** When the previous input event happened, or null for the first one. */
  lastInputAt: number | null;
}

const TYPED = new Set(["insertText", "insertLineBreak", "insertParagraph"]);
const PASTED = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank"]);

export function applyInput(m: TypingMetrics, ctx: InputContext): TypingMetrics {
  const { inputType, selectionStart: start, selectionEnd: end, valueLength } = ctx;
  const next = { ...m };

  if (ctx.lastInputAt !== null) {
    const gap = ctx.now - ctx.lastInputAt;
    if (gap <= IDLE_GAP_MS) next.typingMs += gap;
    if (gap > FREEZE_GAP_MS) {
      next.freezeCount += 1;
      next.longestFreezeMs = Math.max(next.longestFreezeMs, gap);
    }
  }

  const replacesOrInsertsMidText = start !== end || start < valueLength;

  if (TYPED.has(inputType)) {
    next.typed += inputType === "insertText" ? (ctx.data?.length ?? 1) : 1;
    if (replacesOrInsertsMidText) next.edited += 1;
  } else if (PASTED.has(inputType)) {
    next.pasted += ctx.data?.length ?? 0;
    if (replacesOrInsertsMidText) next.edited += 1;
  } else if (inputType.startsWith("delete")) {
    const nothingToDelete =
      start === end &&
      ((inputType.endsWith("Backward") && start === 0) || (inputType.endsWith("Forward") && start === valueLength));
    if (!nothingToDelete) {
      next.edited += 1;
      next.deleted += 1;
    }
  } else if (inputType === "historyUndo" || inputType === "historyRedo" || inputType === "insertReplacementText") {
    next.edited += 1;
  }

  return next;
}
