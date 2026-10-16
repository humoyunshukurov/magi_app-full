import { describe, expect, it } from "vitest";
import { applyInput, emptyMetrics, FREEZE_GAP_MS, IDLE_GAP_MS, type InputContext } from "./typingMetrics";

const ctx = (over: Partial<InputContext>): InputContext => ({
  inputType: "insertText",
  data: "a",
  selectionStart: 0,
  selectionEnd: 0,
  valueLength: 0,
  now: 0,
  lastInputAt: null,
  ...over,
});

describe("applyInput", () => {
  it("counts characters typed at the end of the text without calling it an edit", () => {
    let m = emptyMetrics();
    m = applyInput(m, ctx({ data: "a", selectionStart: 0, selectionEnd: 0, valueLength: 0 }));
    m = applyInput(m, ctx({ data: "b", selectionStart: 1, selectionEnd: 1, valueLength: 1 }));
    expect(m).toMatchObject({ typed: 2, edited: 0, pasted: 0 });
  });

  it("counts an insert in the middle or over a selection as an edit, but not typing at the end", () => {
    const middle = applyInput(emptyMetrics(), ctx({ selectionStart: 2, selectionEnd: 2, valueLength: 5 }));
    expect(middle).toMatchObject({ typed: 1, edited: 1 });
    const atEnd = applyInput(emptyMetrics(), ctx({ selectionStart: 5, selectionEnd: 5, valueLength: 5 }));
    expect(atEnd.edited).toBe(0);
    const overSelection = applyInput(emptyMetrics(), ctx({ selectionStart: 1, selectionEnd: 3, valueLength: 5 }));
    expect(overSelection.edited).toBe(1);
  });

  it("counts deletes as edits, except when there is nothing to delete", () => {
    const backspace = applyInput(emptyMetrics(), ctx({ inputType: "deleteContentBackward", data: null, selectionStart: 3, selectionEnd: 3, valueLength: 3 }));
    expect(backspace.edited).toBe(1);
    const atStart = applyInput(emptyMetrics(), ctx({ inputType: "deleteContentBackward", data: null, selectionStart: 0, selectionEnd: 0, valueLength: 3 }));
    expect(atStart.edited).toBe(0);
    const forwardAtEnd = applyInput(emptyMetrics(), ctx({ inputType: "deleteContentForward", data: null, selectionStart: 3, selectionEnd: 3, valueLength: 3 }));
    expect(forwardAtEnd.edited).toBe(0);
    const cut = applyInput(emptyMetrics(), ctx({ inputType: "deleteByCut", data: null, selectionStart: 0, selectionEnd: 2, valueLength: 3 }));
    expect(cut.edited).toBe(1);
  });

  it("counts deletes separately from other edits too", () => {
    const backspace = applyInput(emptyMetrics(), ctx({ inputType: "deleteContentBackward", data: null, selectionStart: 3, selectionEnd: 3, valueLength: 3 }));
    expect(backspace.deleted).toBe(1);
    const middle = applyInput(emptyMetrics(), ctx({ selectionStart: 2, selectionEnd: 2, valueLength: 5 }));
    expect(middle.deleted).toBe(0);
  });

  it("counts pasted characters separately from typed ones", () => {
    const m = applyInput(emptyMetrics(), ctx({ inputType: "insertFromPaste", data: "twelve chars", selectionStart: 0, selectionEnd: 0, valueLength: 0 }));
    expect(m).toMatchObject({ typed: 0, pasted: 12, edited: 0 });
    const over = applyInput(emptyMetrics(), ctx({ inputType: "insertFromPaste", data: "xyz", selectionStart: 0, selectionEnd: 4, valueLength: 4 }));
    expect(over).toMatchObject({ pasted: 3, edited: 1 });
  });

  it("counts paste operations separately from pasted characters", () => {
    let m = emptyMetrics();
    m = applyInput(m, ctx({ inputType: "insertFromPaste", data: "ab", selectionStart: 0, selectionEnd: 0, valueLength: 0 }));
    m = applyInput(m, ctx({ inputType: "insertFromPaste", data: "cdef", selectionStart: 2, selectionEnd: 2, valueLength: 2 }));
    expect(m).toMatchObject({ pasted: 6, pasteEvents: 2 });
  });

  it("counts undo/redo as edits", () => {
    expect(applyInput(emptyMetrics(), ctx({ inputType: "historyUndo", data: null })).edited).toBe(1);
  });

  it("adds up typing time between quick inputs but ignores long pauses", () => {
    let m = emptyMetrics();
    m = applyInput(m, ctx({ now: 1000, lastInputAt: null }));
    m = applyInput(m, ctx({ now: 1800, lastInputAt: 1000 }));
    m = applyInput(m, ctx({ now: 2300, lastInputAt: 1800 }));
    expect(m.typingMs).toBe(1300);
    m = applyInput(m, ctx({ now: 2300 + IDLE_GAP_MS + 1, lastInputAt: 2300 }));
    expect(m.typingMs).toBe(1300);
  });

  it("counts a long pause as a freeze and tracks the longest one", () => {
    let m = emptyMetrics();
    m = applyInput(m, ctx({ now: 1000, lastInputAt: null }));
    m = applyInput(m, ctx({ now: 1000 + FREEZE_GAP_MS + 1, lastInputAt: 1000 }));
    expect(m.freezeCount).toBe(1);
    expect(m.longestFreezeMs).toBe(FREEZE_GAP_MS + 1);
    m = applyInput(m, ctx({ now: m.typingMs + 1000, lastInputAt: 1000 + FREEZE_GAP_MS + 1 }));
    expect(m.freezeCount).toBe(1);
    m = applyInput(m, ctx({ now: m.typingMs + 1000 + FREEZE_GAP_MS + 5000, lastInputAt: m.typingMs + 1000 }));
    expect(m.freezeCount).toBe(2);
    expect(m.longestFreezeMs).toBe(FREEZE_GAP_MS + 5000);
  });
});
