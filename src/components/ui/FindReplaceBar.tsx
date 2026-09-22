import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronUp, Search, X } from "../icons";
import { cn } from "../lib/utils";
import { collectMatches } from "./richTextFindReplace";
import { Button } from "./button";
import { Input } from "./input";

interface FindReplaceBarProps {
  editorRef: MutableRefObject<Editor | null>;
  /** Hides the replace controls when the transcript is read-only. */
  canEdit: boolean;
}

export function FindReplaceBar({ editorRef, canEdit }: FindReplaceBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const barRootRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const stateRef = useRef({ query, replacement, caseSensitive, matchIndex });
  stateRef.current = { query, replacement, caseSensitive, matchIndex };

  const getEditor = useCallback(() => editorRef.current, [editorRef]);

  const applyHighlight = useCallback(
    (matches: { from: number; to: number }[], active: number) => {
      const editor = getEditor();
      if (!editor) return;
      editor.commands.setFindMatches(matches, active);
      const match = matches[active];
      if (!match) return;
      editor.commands.setTextSelection({ from: match.from, to: match.to });
      editor.commands.scrollIntoView();
    },
    [getEditor]
  );

  const recompute = useCallback(
    (queryText: string, sensitive: boolean, preferred: number) => {
      const editor = getEditor();
      const matches = editor ? collectMatches(editor, queryText, sensitive) : [];
      setMatchCount(matches.length);
      const active = matches.length ? Math.min(preferred, matches.length - 1) : -1;
      setMatchIndex(active < 0 ? 0 : active);
      applyHighlight(matches, active);
    },
    [applyHighlight, getEditor]
  );

  useEffect(() => {
    recompute(query, caseSensitive, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive]);

  // Keep highlights fresh while the document changes underneath the bar.
  useEffect(() => {
    const subscribe = () => {
      const editor = getEditor();
      if (!editor) return false;
      const handleTransaction = ({
        transaction,
      }: {
        transaction: { docChanged: boolean };
      }) => {
        if (!transaction.docChanged) return;
        const s = stateRef.current;
        if (!s.query) return;
        const matches = collectMatches(editor, s.query, s.caseSensitive);
        const active = matches.length ? Math.min(s.matchIndex, matches.length - 1) : -1;
        setMatchCount(matches.length);
        setMatchIndex(active < 0 ? 0 : active);
        editor.commands.setFindMatches(matches, active);
      };
      editor.on("transaction", handleTransaction);
      return true;
    };
    if (subscribe()) return () => getEditor()?.off("transaction");
    // Editor mounts in the same commit as the bar; retry briefly.
    const idle = setInterval(() => {
      if (subscribe()) clearInterval(idle);
    }, 100);
    return () => clearInterval(idle);
  }, [getEditor]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setReplacement("");
    setCaseSensitive(false);
    setMatchCount(0);
    setMatchIndex(0);
    const editor = getEditor();
    if (editor) {
      editor.commands.setFindMatches([], -1);
      editor.commands.focus();
    }
  }, [getEditor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setOpen(true);
        findInputRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && open && barRootRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  useEffect(() => {
    if (open) findInputRef.current?.focus();
  }, [open]);

  const goTo = (direction: 1 | -1) => {
    const editor = getEditor();
    if (!editor || !query) return;
    const matches = collectMatches(editor, query, caseSensitive);
    if (!matches.length) return;
    const next = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(next);
    applyHighlight(matches, next);
  };

  const replaceOne = () => {
    const editor = getEditor();
    if (!editor || !query) return;
    const matches = collectMatches(editor, query, caseSensitive);
    const index = matches.length ? Math.min(matchIndex, matches.length - 1) : -1;
    if (index < 0) return;
    const current = matches[index];
    const nextBegin = current.from + replacement.length;
    const tr = editor.state.tr.insertText(replacement, current.from, current.to);
    editor.view.dispatch(tr);
    const remaining = collectMatches(editor, query, caseSensitive);
    const skipTo = remaining.findIndex((match) => match.from >= nextBegin);
    const active = remaining.length ? (skipTo === -1 ? 0 : skipTo) : -1;
    setMatchCount(remaining.length);
    setMatchIndex(active < 0 ? 0 : active);
    applyHighlight(remaining, active);
  };

  const replaceAll = () => {
    const editor = getEditor();
    if (!editor || !query) return;
    const matches = collectMatches(editor, query, caseSensitive);
    if (!matches.length) return;
    const tr = editor.state.tr;
    for (const match of [...matches].reverse()) {
      tr.insertText(replacement, match.from, match.to);
    }
    editor.view.dispatch(tr);
    const remaining = collectMatches(editor, query, caseSensitive);
    setMatchCount(remaining.length);
    setMatchIndex(0);
    applyHighlight(remaining, remaining.length ? 0 : -1);
  };

  const routeUndoRedo = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    const editor = getEditor();
    if (event.shiftKey) {
      editor?.commands.redo();
    } else {
      editor?.commands.undo();
    }
  };

  const navDisabled = !query || !matchCount;

  if (!open) return null;

  return (
    <div
      ref={barRootRef}
      className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-surface-1 p-1.5 dark:bg-surface-raised/90"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          ref={findInputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            routeUndoRedo(event);
            if (event.key === "Enter") {
              if (event.shiftKey) goTo(-1);
              else goTo(1);
            }
          }}
          placeholder={t("notes.editor.findReplaceFind")}
          className="h-8 w-44 pl-7 text-xs"
        />
      </div>
      <span className="w-16 text-center text-[11px] tabular-nums leading-none text-muted-foreground">
        {matchCount
          ? t("notes.editor.findReplaceMatches", {
              current: matchIndex + 1,
              total: matchCount,
            })
          : t("notes.editor.findReplaceNoMatches")}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => goTo(-1)}
        disabled={navDisabled}
        title={t("notes.editor.findReplacePrevious")}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => goTo(1)}
        disabled={navDisabled}
        title={t("notes.editor.findReplaceNext")}
      >
        <ChevronDown />
      </Button>
      {canEdit && (
        <>
          <span className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />
          <Input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              routeUndoRedo(event);
              if (event.key === "Enter") replaceOne();
            }}
            placeholder={t("notes.editor.findReplaceReplace")}
            className="h-8 w-36 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            onClick={replaceOne}
            disabled={navDisabled}
          >
            {t("notes.editor.findReplaceReplace")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            onClick={replaceAll}
            disabled={navDisabled}
          >
            {t("notes.editor.findReplaceReplaceAll")}
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-8", caseSensitive && "text-primary")}
        onClick={() => setCaseSensitive((value) => !value)}
        title={t("notes.editor.findReplaceCaseSensitive")}
      >
        <span className="text-[11px] font-bold leading-none">Aa</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={close}
        title={t("notes.editor.findReplaceClose")}
      >
        <X />
      </Button>
    </div>
  );
}