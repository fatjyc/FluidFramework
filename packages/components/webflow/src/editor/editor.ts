/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IComponent } from "@prague/component-core-interfaces";
import { Caret as CaretUtil, Direction, getDeltaX, getDeltaY, KeyCode } from "@prague/flow-util";
import { paste } from "../clipboard/paste";
import { DocSegmentKind, FlowDocument, getDocSegmentKind } from "../document";
import { Caret } from "./caret";
import { debug } from "./debug";
import * as styles from "./index.css";
import { Layout } from "./view/layout";

export class Editor {
    private readonly layout: Layout;
    private readonly caret: Caret;
    private get doc() { return this.layout.doc; }

    constructor(doc: FlowDocument, root: HTMLElement, scope?: IComponent) {
        this.layout = new Layout(doc, root, scope);
        this.caret = new Caret(this.layout);

        root.tabIndex = 0;
        root.contentEditable = "true";
        root.addEventListener("paste", this.onPaste);
        root.addEventListener("keydown", this.onKeyDown);
        root.addEventListener("keypress", this.onKeyPress);
    }

    public get selection() { return this.caret.selection; }

    private delete(e: Event, direction: Direction) {
        this.consume(e);

        const caret = this.caret;
        let { start, end } = caret.selection;

        if (start === end) {
            // If no range is currently selected, delete the preceding character (if any).
            const dx = getDeltaX(direction);
            if (dx < 0) {
                start--;
            } else {
                end++;
            }
        }

        const doc = this.doc;
        doc.remove(Math.max(0, start), Math.min(end, doc.length));
        caret.collapseForward();
        caret.sync();
    }

    private unlinkChildren(node: Node | HTMLElement) {
        while (node.lastChild) {
            // Leave an inclusion's content alone.
            if ("classList" in node && node.classList.contains(styles.inclusion)) {
                break;
            }
            const child = node.lastChild;
            node.removeChild(child);
            this.unlinkChildren(child);
        }
    }

    private shouldHandleEvent(e: Event) {
        const root = this.layout.root;
        let target = e.target as HTMLElement;

        while (target !== null && target !== root) {
            if (target.classList.contains(styles.inclusion)) {
                return false;
            }
            target = target.parentElement;
        }
        return target === root;
    }

    private readonly onKeyDown = (e: KeyboardEvent) => {
        if (!this.shouldHandleEvent(e)) {
            return;
        }

        switch (e.code) {
            case KeyCode.F4: {
                console.clear();
                break;
            }

            case KeyCode.F5: {
                console.clear();
                debug(`*** RESET ***`);
                this.unlinkChildren(this.layout.root);
                this.layout.sync();
                this.caret.sync();
                break;
            }

            case KeyCode.arrowLeft:
                this.enterIfInclusion(e, this.caret.position - 1, Direction.left);
                break;

            case KeyCode.arrowRight:
                this.enterIfInclusion(e, this.caret.position, Direction.right);
                break;

            // Note: Chrome 69 delivers backspace on 'keydown' only (i.e., 'keypress' is not fired.)
            case KeyCode.backspace: {
                this.delete(e, Direction.left);
                break;
            }
            case KeyCode.delete: {
                this.delete(e, Direction.right);
                break;
            }
            default: {
                debug(`Key: ${e.key} (${e.keyCode})`);
            }
        }
    }

    private readonly onPaste = (e: ClipboardEvent) => {
        if (!this.shouldHandleEvent(e)) {
            return;
        }

        this.consume(e);
        paste(this.doc, e.clipboardData, this.caret.position);
    }

    private readonly onKeyPress = (e: KeyboardEvent) => {
        if (!this.shouldHandleEvent(e)) {
            return;
        }

        this.consume(e);

        switch (e.code) {
            case KeyCode.enter: {
                const caret = this.caret;
                const position = caret.position;
                if (e.shiftKey) {
                    this.doc.insertLineBreak(position);
                } else {
                    this.doc.insertParagraph(position);
                }
                caret.sync();
                break;
            }
            default: {
                this.insertText(e);
            }
        }
    }

    private insertText(e: KeyboardEvent) {
        const { start, end } = this.caret.selection;
        if (start === end) {
            this.doc.insertText(end, e.key);
        } else {
            this.doc.replaceWithText(start, end, e.key);
        }
        this.caret.collapseForward();
        this.caret.sync();
    }

    private consume(e: Event) {
        e.preventDefault();
        e.stopPropagation();
    }

    private enterIfInclusion(e: Event, position: number, direction: Direction) {
        const { segment } = this.doc.getSegmentAndOffset(position);
        const kind = getDocSegmentKind(segment);
        if (kind === DocSegmentKind.inclusion) {
            const { node } = this.layout.segmentAndOffsetToNodeAndOffset(segment, 0);
            const bounds = this.caret.bounds;
            debug("Entering inclusion: (dx=%d,dy=%d,bounds=%o)", getDeltaX(direction), getDeltaY(direction), bounds);
            if (CaretUtil.caretEnter(node as Element, direction, bounds)) {
                this.consume(e);
            }
        }
    }
}
