import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

export interface FindMatch {
  from: number;
  to: number;
}

const findReplaceKey = new PluginKey("findReplaceHighlight");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    findReplace: {
      /** Draws the find/replace match highlights. Pass an empty array to clear. */
      setFindMatches: (matches: FindMatch[], activeIndex: number) => ReturnType;
    };
  }
}

/** Walks the document gathering non-overlapping matches of `query`. */
export function collectMatches(
  editor: Editor,
  query: string,
  caseSensitive: boolean
): FindMatch[] {
  if (!editor || !query) return [];
  const matches: FindMatch[] = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const text = caseSensitive ? node.text : node.text.toLowerCase();
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + query.length });
      idx = text.indexOf(needle, idx + query.length);
    }
    return true;
  });
  return matches;
}

export const findReplaceHighlight = Extension.create({
  name: "findReplaceHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: findReplaceKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, _oldState, newState) {
            const meta = tr.getMeta(findReplaceKey);
            if (meta) return meta as DecorationSet;
            return set.map(tr.mapping, newState.doc);
          },
        },
        props: {
          decorations(this: Plugin, state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setFindMatches:
        (matches: FindMatch[], activeIndex: number) =>
        ({ tr, dispatch, state }) => {
          if (!dispatch) return true;
          const decorations = matches.map((match, index) =>
            Decoration.inline(match.from, match.to, {
              class:
                index === activeIndex
                  ? "find-replace-match find-replace-match--active"
                  : "find-replace-match",
            })
          );
          tr.setMeta(
            findReplaceKey,
            DecorationSet.create(state.doc, decorations)
          );
          return true;
        },
    };
  },
});