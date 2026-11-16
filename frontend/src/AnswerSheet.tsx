import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Heading from "@tiptap/extension-heading";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { applyInput, type TypingMetrics } from "./typingMetrics";

// word-processor style editor for text answers. typing counters are taken on beforeinput.
// markdown shortcuts are turned off so formatting never changes by itself
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

// no icon library, drawn by hand
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
  const { t } = useTranslation();
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
      // read once, this editor owns the content after that
      content: value,
      onUpdate: ({ editor }) => onChangeRef.current(editor.isEmpty ? "" : editor.getHTML(), counters.current),
      editorProps: {
        attributes: {
          "aria-label": label,
          class: "outline-none leading-relaxed text-base min-h-[85vh] p-16",
        },
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    // for tests - a contenteditable has no .value
    (el as unknown as { __editor: typeof editor }).__editor = editor;
    // plain text offsets, not prosemirror positions
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
      {/* sticky toolbar, page below it */}
      <div role="toolbar" aria-label={t("answerSheet.formatting")} className="sticky top-0 z-10 flex flex-col gap-1.5 px-3 py-2 bg-magi-surface border-b border-magi-border shadow-sm">
        {/* Text: what the letters themselves look like. */}
        <div className="flex flex-wrap items-center gap-1">
          <ToolbarSelect label={t("answerSheet.paragraphStyle")} value={String(toolbar.headingLevel)} onChange={(v) => setHeadingLevel(Number(v) as HeadingLevel)}>
            <option value="0">{t("answerSheet.normalText")}</option>
            <option value="1">{t("answerSheet.heading1")}</option>
            <option value="2">{t("answerSheet.heading2")}</option>
            <option value="3">{t("answerSheet.heading3")}</option>
          </ToolbarSelect>
          <ToolbarSelect label={t("answerSheet.fontSize")} value={toolbar.fontSize} onChange={setFontSize}>
            <option value="">{t("answerSheet.defaultSize")}</option>
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarDivider />
          <ToolbarButton label={t("answerSheet.bold")} active={toolbar.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <span className="font-bold">B</span>
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.italic")} active={toolbar.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <span className="italic">I</span>
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.underline")} active={toolbar.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
            <span className="underline">U</span>
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.strikethrough")} active={toolbar.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <span className="line-through">S</span>
          </ToolbarButton>
        </div>

        {/* Paragraph: how lines and blocks are laid out, plus undo/redo. */}
        <div className="flex flex-wrap items-center gap-1">
          <ToolbarButton label={t("answerSheet.bulletList")} active={toolbar.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <BulletListIcon />
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.numberedList")} active={toolbar.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <NumberedListIcon />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label={t("answerSheet.alignLeft")} active={toolbar.alignLeft} onClick={() => editor.chain().focus().setTextAlign("left").run()}>
            <AlignLeftIcon />
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.alignCenter")} active={toolbar.alignCenter} onClick={() => editor.chain().focus().setTextAlign("center").run()}>
            <AlignCenterIcon />
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.alignRight")} active={toolbar.alignRight} onClick={() => editor.chain().focus().setTextAlign("right").run()}>
            <AlignRightIcon />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label={t("answerSheet.undo")} disabled={!toolbar.canUndo} onClick={() => editor.chain().focus().undo().run()}>
            <UndoIcon />
          </ToolbarButton>
          <ToolbarButton label={t("answerSheet.redo")} disabled={!toolbar.canRedo} onClick={() => editor.chain().focus().redo().run()}>
            <RedoIcon />
          </ToolbarButton>
          <span className="ml-auto pr-1 text-xs text-magi-secondary" aria-live="polite">
            {t("answerSheet.wordCount", { count: toolbar.wordCount })}
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
