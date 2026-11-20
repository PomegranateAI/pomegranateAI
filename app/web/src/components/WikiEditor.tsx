/**
 * WikiEditor — the unified, always-editable wiki page body (spec-wiki.md).
 *
 * A single continuous TipTap (ProseMirror) document per page. There is no
 * "edit" mode and no fixed text box: the rendered content IS the editable
 * surface. Select text for a formatting bubble (bold / italic / headings /
 * lists / quote / link); the "+" affordance on an empty line inserts an image
 * or link. Content round-trips to the wiki's block store: each top-level node
 * is one block, matched by a `data-block-id` so existing blocks keep their
 * citations / provenance / review across edits. Saves are debounced and flush
 * on blur.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import { Extension } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  Italic,
  Strikethrough,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link as LinkIcon,
  Image as ImageIcon,
} from 'lucide-react';
import type { WikiBlockRecord } from '../api.js';
import { safeHtml } from '../lib/safe-html.js';

export interface WikiBodyBlock {
  id?: string;
  type: string;
  content: { text: string };
}

// Block-level node types that carry a block identity + can be inserted.
const BLOCK_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'image', 'blockquote', 'codeBlock'];

// A global attribute so every top-level node round-trips its source block id via
// `data-block-id`. This is how a save maps editor nodes back to stored blocks
// without losing their citations / provenance.
const BlockId = Extension.create({
  name: 'blockId',
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
    ];
  },
});

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}
function genId(): string {
  // Client-minted block id; the server honors it on insert so a later save
  // matches instead of duplicating. Crypto-free to keep it dependency-light.
  let s = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return `wb_${s}`;
}

// Turn a stored block into the HTML for one (or more) top-level element(s),
// each tagged with the block's id.
function blockToHtml(block: WikiBlockRecord): string {
  let html: string;
  if (block.type === 'image' && block.content.url) {
    html = `<img src="${esc(block.content.url)}" alt="${esc(block.content.alt ?? '')}">`;
  } else if (block.type === 'list' && block.content.items?.length) {
    html = `<ul>${block.content.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`;
  } else {
    const t = block.content.text ?? '';
    html = looksLikeHtml(t) ? t : `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;
  }
  // Stamp the block id onto each top-level element.
  const tpl = document.createElement('template');
  tpl.innerHTML = safeHtml(html.trim());
  tpl.content.childNodes.forEach((n) => {
    if (n.nodeType === 1 && block.id) (n as Element).setAttribute('data-block-id', block.id);
  });
  return tpl.innerHTML;
}

function initialContent(blocks: WikiBlockRecord[]): string {
  const parts = blocks.map(blockToHtml).filter(Boolean);
  return parts.length > 0 ? parts.join('') : '<p></p>';
}

function nodeBlockType(typeName: string): string {
  if (typeName === 'heading') return 'heading';
  if (typeName === 'bulletList' || typeName === 'orderedList') return 'list';
  if (typeName === 'image') return 'image';
  return 'paragraph';
}

function isEmptyHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '') === '' && !/<img\b/i.test(html);
}

interface CollectResult {
  blocks: WikiBodyBlock[];
  assigns: Array<{ pos: number; id: string }>;
}

// Walk the document top-level nodes into the ordered block list to persist,
// minting ids for new nodes (recorded in `assigns` so we can stamp them back
// onto the doc, keeping subsequent saves idempotent).
function collect(editor: NonNullable<ReturnType<typeof useEditor>>): CollectResult {
  const { doc } = editor.state;
  const serializer = DOMSerializer.fromSchema(editor.schema);
  const groups: Array<{ id: string; type: string; htmls: string[] }> = [];
  const used = new Set<string>();
  const assigns: Array<{ pos: number; id: string }> = [];

  doc.forEach((node, offset) => {
    const el = serializer.serializeNode(node);
    const div = document.createElement('div');
    div.appendChild(el);
    const html = div.innerHTML;
    if (isEmptyHtml(html)) return; // drop blank lines — not meaningful as blocks

    let id: string | null = node.attrs.blockId ?? null;
    const last = groups[groups.length - 1];
    if (id && last && last.id === id && used.has(id)) {
      last.htmls.push(html); // consecutive run of the same source block
      return;
    }
    if (id && used.has(id)) id = null; // a duplicated id elsewhere → treat as new
    if (!id) {
      id = genId();
      assigns.push({ pos: offset, id });
    }
    used.add(id);
    groups.push({ id, type: nodeBlockType(node.type.name), htmls: [html] });
  });

  const blocks = groups.map((g) => ({ id: g.id, type: g.type, content: { text: g.htmls.join('') } }));
  return { blocks, assigns };
}

function applyAssigns(editor: NonNullable<ReturnType<typeof useEditor>>, assigns: Array<{ pos: number; id: string }>) {
  if (!assigns.length) return;
  const { tr } = editor.state;
  for (const a of assigns) {
    const node = editor.state.doc.nodeAt(a.pos);
    if (node) tr.setNodeMarkup(a.pos, undefined, { ...node.attrs, blockId: a.id });
  }
  tr.setMeta('addToHistory', false);
  tr.setMeta('blockIdAssign', true);
  editor.view.dispatch(tr);
}

function signature(blocks: WikiBodyBlock[]): string {
  return JSON.stringify(blocks.map((b) => [b.id, b.type, b.content.text]));
}

export interface WikiEditorHandle {
  /** Persist any pending edits now and resolve when the save settles. Callers
   *  use this to flush BEFORE a state change that will remount the editor (e.g.
   *  accepting a suggestion), so the unmount flush can't race and clobber. */
  flush: () => Promise<void>;
}

interface WikiEditorProps {
  blocks: WikiBlockRecord[];
  onSave: (blocks: WikiBodyBlock[]) => Promise<WikiBlockRecord[]>;
  onSaved?: (blocks: WikiBlockRecord[]) => void;
  editable?: boolean;
}

export const WikiEditor = forwardRef<WikiEditorHandle, WikiEditorProps>(function WikiEditor(
  { blocks, onSave, onSaved, editable = true },
  ref,
) {
  const lastSig = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);

  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: false, underline: false }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } }),
      Image.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder: 'Write here… select text to format, or use + to add an image.' }),
      BlockId,
    ],
    content: initialContent(blocks),
    editorProps: {
      attributes: { class: 'wiki-prose focus:outline-none' },
    },
    onCreate: ({ editor }) => {
      lastSig.current = signature(collect(editor).blocks);
    },
  });

  const doSave = useCallback(async () => {
    if (!editor || saving.current) return;
    const { blocks: next, assigns } = collect(editor);
    const sig = signature(next);
    if (sig === lastSig.current) return;
    applyAssigns(editor, assigns);
    lastSig.current = sig;
    saving.current = true;
    try {
      const list = await onSave(next);
      onSaved?.(list);
    } catch {
      lastSig.current = null; // let the next edit retry
    } finally {
      saving.current = false;
    }
  }, [editor, onSave, onSaved]);

  useImperativeHandle(
    ref,
    () => ({
      flush: async () => {
        if (timer.current) clearTimeout(timer.current);
        await doSave();
      },
    }),
    [doSave],
  );

  // Debounced autosave on edit + flush on blur/unmount.
  useEffect(() => {
    if (!editor) return;
    const onUpdate = ({ transaction }: { transaction: { getMeta: (k: string) => unknown } }) => {
      if (transaction.getMeta('blockIdAssign')) return; // our own id-stamping tx
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void doSave(), 900);
    };
    const onBlur = () => {
      if (timer.current) clearTimeout(timer.current);
      void doSave();
    };
    editor.on('update', onUpdate);
    editor.on('blur', onBlur);
    return () => {
      editor.off('update', onUpdate);
      editor.off('blur', onBlur);
      if (timer.current) clearTimeout(timer.current);
      void doSave();
    };
  }, [editor, doSave]);

  if (!editor) return null;

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', prev ?? 'https://');
    if (url === null) return;
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  const insertImage = () => {
    const url = window.prompt('Image URL');
    if (!url?.trim()) return;
    const alt = window.prompt('Alt text (optional)') ?? '';
    editor.chain().focus().setImage({ src: url.trim(), alt }).run();
  };

  const btn = (active: boolean) =>
    `rounded p-1.5 hover:bg-muted ${active ? 'bg-muted text-foreground' : 'text-muted-foreground'}`;

  return (
    <div className="wiki-editor">
      {editable && (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-md"
        >
          <button type="button" className={btn(editor.isActive('bold'))} title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('italic'))} title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('strike'))} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
            <Strikethrough className="size-4" />
          </button>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <button type="button" className={btn(editor.isActive('heading', { level: 2 }))} title="Heading" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            <Heading2 className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('heading', { level: 3 }))} title="Subheading" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
            <Heading3 className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('bulletList'))} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('orderedList'))} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrdered className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('blockquote'))} title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <Quote className="size-4" />
          </button>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <button type="button" className={btn(editor.isActive('link'))} title="Link" onClick={setLink}>
            <LinkIcon className="size-4" />
          </button>
        </BubbleMenu>
      )}

      {editable && (
        <FloatingMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-md"
        >
          <button type="button" className={btn(editor.isActive('heading', { level: 2 }))} title="Heading" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            <Heading2 className="size-4" />
          </button>
          <button type="button" className={btn(editor.isActive('bulletList'))} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List className="size-4" />
          </button>
          <button type="button" className={btn(false)} title="Insert image" onClick={insertImage}>
            <ImageIcon className="size-4" />
          </button>
          <button type="button" className={btn(false)} title="Insert link" onClick={setLink}>
            <LinkIcon className="size-4" />
          </button>
        </FloatingMenu>
      )}

      <EditorContent editor={editor} />
    </div>
  );
});
