import { useEffect, useRef } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Heading from "@tiptap/extension-heading";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { applyInput, type TypingMetrics } from "./typingMetrics";

// The white sheet a text answer is written on, styled and driven like a plain word processor:
// a toolbar for the formatting everyone actually uses (headings, bold/italic/underline/strike,
// font size, lists, alignment, undo/redo), a page-like editable area below it. Every edit is
// folded into the typing counters on the editor's own `beforeinput` (fired before the change
// lands, so the selection is still the one the edit acts on) — same event this component used
// when the answer was a plain `<textarea>`, just now read off the document's own position/size
// instead of a string's.
//
// Formatting only ever happens from a deliberate click or a real shortcut (Ctrl+B and the like),
// never from typing ordinary punctuation: the marks/nodes below that normally auto-convert
// markdown as you type (`**bold**`, `# heading`, …) have that switched off, so nothing about an
// exam answer's formatting changes behind the student's back.
const NoSurpriseHeading = Heading.extend({ addInputRules: () => [] });
const NoSurpriseBold = Bold.extend({ addInputRules: () => [] });
const NoSurpriseItalic = Italic.extend({ addInputRules: () => [] });
const NoSurpriseStrike = Strike.extend({ addInputRules: () => [] });

const FONT_SIZES = ["12", "14", "16", "18", "24", "32"];
type HeadingLevel = 0 | 1 | 2 | 3;

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-md text-base font-semibold border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active ? "bg-magi-primary text-white border-magi-primary" : "border-magi-border bg-magi-white text-magi-primary hover:border-magi-primary"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 shrink-0 rounded-md border border-magi-border bg-magi-white px-2 text-sm text-magi-primary hover:border-magi-primary focus:outline-none focus:border-magi-primary"
    >
      {children}
    </select>
  );
}

const ToolbarDivider = () => <span className="w-px h-5 bg-magi-border mx-1 shrink-0" aria-hidden="true" />;

// Plain, recognizable pictograms instead of arrows/letters for the actions where a real icon
// reads faster than text — this app has no icon library, so these are hand-drawn, not imported.
const AlignLeftIcon = () => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M1 1h16M1 5h10M1 9h16M1 13h10" />
  </svg>
);
const AlignCenterIcon = () => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M1 1h16M4 5h10M1 9h16M4 13h10" />
  </svg>
);
const AlignRightIcon = () => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M1 1h16M7 5h10M1 9h16M7 13h10" />
  </svg>
);
const BulletListIcon = () => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="1.5" cy="1.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="1.5" cy="7" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="1.5" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
    <path d="M6 1.5h11M6 7h11M6 12.5h11" />
  </svg>
);
const NumberedListIcon = () => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <text x="0" y="3" fontSize="4.2" fill="currentColor" stroke="none" fontWeight="700">
      1.
    </text>
    <text x="0" y="8.5" fontSize="4.2" fill="currentColor" stroke="none" fontWeight="700">
      2.
    </text>
    <text x="0" y="14" fontSize="4.2" fill="currentColor" stroke="none" fontWeight="700">
      3.
    </text>
    <path d="M6 1.5h11M6 7h11M6 12.5h11" />
  </svg>
);
const UndoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7h6a4 4 0 1 1 0 8H7" />
    <path d="M6 3 2 7l4 4" />
  </svg>
);
const RedoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 7H7a4 4 0 1 0 0 8h2" />
    <path d="M10 3l4 4-4 4" />
  </svg>
);

export function AnswerSheet({
  value,
  metrics,
  label,
  onChange,
}: {
  value: string;
  /** Counters so far; read once on mount, this component is their only writer afterwards. */
  metrics: TypingMetrics;
  label: string;
  onChange: (value: string, metrics: TypingMetrics) => void;
}) {
  const counters = useRef(metrics);
  const lastInputAt = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: false,
          bold: false,
          italic: false,
          strike: false,
          blockquote: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          link: false,
        }),
        NoSurpriseHeading.configure({ levels: [1, 2, 3] }),
        NoSurpriseBold,
        NoSurpriseItalic,
        NoSurpriseStrike,
        TextAlign.configure({ types: ["paragraph", "heading"] }),
        TextStyleKit.configure({ backgroundColor: false, color: false, fontFamily: false, lineHeight: false }),
      ],
      // Read once: this question's answer is fixed by the time it first mounts (the exam
      // waits for the server/local drafts before rendering any question at all), and after
      // that this editor is the only writer of its own content.
      content: value,
      onUpdate: ({ editor }) => onChangeRef.current(editor.isEmpty ? "" : editor.getHTML(), counters.current),
      editorProps: {
        attributes: {
          "aria-label": label,
          // Short-answer questions get the same generous page as an essay - a real document
          // page doesn't shrink depending on how much a question expects you to write.
          class: "outline-none leading-relaxed text-base min-h-[85vh] p-16",
        },
      },
    },
    [],
  );

  // Everything the student does inside the answer — typing, pasting, deleting, undo/redo —
  // fires a real `beforeinput` on the editable region, contenteditable included, before it
  // lands. Same counting as the plain textarea this replaced.
  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    // Tests reach the live editor through this (there's no `.value`/`.selectionStart` on a
    // contenteditable div to drive from the outside, the way there was for a `<textarea>`).
    (el as unknown as { __editor: typeof editor }).__editor = editor;
    // `applyInput` was written for a `<textarea>`'s linear string, so it's given plain-text
    // character offsets here too — not the document's own node positions, which count each
    // paragraph/list boundary as an extra position and would make an empty document look like
    // it already has text at position 1.
    const textOffset = (pos: number) => editor.state.doc.textBetween(0, pos, "\n", "\n").length;
    const onBeforeInput = (e: Event) => {
      const event = e as InputEvent;
      const now = Date.now();
      const { from, to } = editor.state.selection;
      counters.current = applyInput(counters.current, {
        inputType: event.inputType,
        data: event.data ?? event.dataTransfer?.getData("text/plain") ?? null,
        selectionStart: textOffset(from),
        selectionEnd: textOffset(to),
        valueLength: textOffset(editor.state.doc.content.size),
        now,
        lastInputAt: lastInputAt.current,
      });
      lastInputAt.current = now;
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [editor]);

  const toolbar = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      alignLeft: e.isActive({ textAlign: "left" }),
      alignCenter: e.isActive({ textAlign: "center" }),
      alignRight: e.isActive({ textAlign: "right" }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      headingLevel: ([1, 2, 3] as const).find((level) => e.isActive("heading", { level })) ?? (0 as HeadingLevel),
      fontSize: (e.getAttributes("textStyle").fontSize as string | undefined)?.replace("px", "") ?? "",
      wordCount: e.state.doc.textContent.trim() === "" ? 0 : e.state.doc.textContent.trim().split(/\s+/).length,
    }),
  });

  if (!editor || !toolbar) return null;

  const setHeadingLevel = (level: HeadingLevel) => {
    const chain = editor.chain().focus();
    (level === 0 ? chain.setParagraph() : chain.setHeading({ level })).run();
  };

  const setFontSize = (size: string) => {
    const chain = editor.chain().focus();
    (size === "" ? chain.unsetFontSize() : chain.setFontSize(`${size}px`)).run();
  };

  return (
    <div className="w-full">
      {/* The ribbon stays at the top, full width, and sticks there while a long answer scrolls.
          The page floats below it on its own gray "desk", with a real gap above it — not glued
          to the ribbon the way an earlier version had it — the way a real word processor looks. */}
      <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 flex flex-col gap-1.5 px-3 py-2 bg-magi-surface border-b border-magi-border shadow-sm">
        {/* Text: what the letters themselves look like. */}
        <div className="flex flex-wrap items-center gap-1">
          <ToolbarSelect label="Paragraph style" value={String(toolbar.headingLevel)} onChange={(v) => setHeadingLevel(Number(v) as HeadingLevel)}>
            <option value="0">Normal text</option>
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
          </ToolbarSelect>
          <ToolbarSelect label="Font size" value={toolbar.fontSize} onChange={setFontSize}>
            <option value="">Default size</option>
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarDivider />
          <ToolbarButton label="Bold" active={toolbar.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <span className="font-bold">B</span>
          </ToolbarButton>
          <ToolbarButton label="Italic" active={toolbar.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <span className="italic">I</span>
          </ToolbarButton>
          <ToolbarButton label="Underline" active={toolbar.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
            <span className="underline">U</span>
          </ToolbarButton>
          <ToolbarButton label="Strikethrough" active={toolbar.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <span className="line-through">S</span>
          </ToolbarButton>
        </div>

        {/* Paragraph: how lines and blocks are laid out, plus undo/redo. */}
        <div className="flex flex-wrap items-center gap-1">
          <ToolbarButton label="Bullet list" active={toolbar.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <BulletListIcon />
          </ToolbarButton>
          <ToolbarButton label="Numbered list" active={toolbar.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <NumberedListIcon />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label="Align left" active={toolbar.alignLeft} onClick={() => editor.chain().focus().setTextAlign("left").run()}>
            <AlignLeftIcon />
          </ToolbarButton>
          <ToolbarButton label="Align center" active={toolbar.alignCenter} onClick={() => editor.chain().focus().setTextAlign("center").run()}>
            <AlignCenterIcon />
          </ToolbarButton>
          <ToolbarButton label="Align right" active={toolbar.alignRight} onClick={() => editor.chain().focus().setTextAlign("right").run()}>
            <AlignRightIcon />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label="Undo" disabled={!toolbar.canUndo} onClick={() => editor.chain().focus().undo().run()}>
            <UndoIcon />
          </ToolbarButton>
          <ToolbarButton label="Redo" disabled={!toolbar.canRedo} onClick={() => editor.chain().focus().redo().run()}>
            <RedoIcon />
          </ToolbarButton>
          <span className="ml-auto pr-1 text-xs text-magi-secondary" aria-live="polite">
            {toolbar.wordCount} {toolbar.wordCount === 1 ? "word" : "words"}
          </span>
        </div>
      </div>

      <div className="bg-magi-surface px-6 pt-8 pb-10">
        <EditorContent
          editor={editor}
          className="mx-auto max-w-4xl bg-magi-white border border-magi-border shadow-lg rounded-sm text-magi-primary focus-within:border-magi-primary"
        />
      </div>
    </div>
  );
}
