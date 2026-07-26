/** The split tree: leaves are consoles, branches are a row or a column of them.
 *
 * Nothing here touches the DOM. `main.ts` renders a tree into nested flex
 * boxes, where every node's `share` is its flex-grow factor among its siblings. */

import type { TerminalPane } from './pane';

/** `row` puts consoles side by side, `column` stacks them. */
export type Direction = 'row' | 'column';

export interface Leaf {
  kind: 'leaf';
  pane: TerminalPane;
  share: number;
}

export interface Branch {
  kind: 'branch';
  dir: Direction;
  share: number;
  /** Always two or more: `simplify` collapses a branch that drops below that. */
  children: LayoutNode[];
}

export type LayoutNode = Leaf | Branch;

export function leaf(pane: TerminalPane, share = 1): Leaf {
  return { kind: 'leaf', pane, share };
}

/** Every console in the tree, left to right and top to bottom. */
export function leaves(node: LayoutNode): TerminalPane[] {
  return node.kind === 'leaf' ? [node.pane] : node.children.flatMap(leaves);
}

export function findLeaf(node: LayoutNode, pane: TerminalPane): Leaf | null {
  if (node.kind === 'leaf') return node.pane === pane ? node : null;
  for (const child of node.children) {
    const hit = findLeaf(child, pane);
    if (hit) return hit;
  }
  return null;
}

export function findParent(node: LayoutNode, child: LayoutNode): Branch | null {
  if (node.kind === 'leaf') return null;
  if (node.children.includes(child)) return node;
  for (const other of node.children) {
    const hit = findParent(other, child);
    if (hit) return hit;
  }
  return null;
}

/**
 * Splits `pane` along `dir` and puts `added` in the half that frees up.
 * Splitting the same way twice extends the branch that is already there;
 * splitting the other way nests a new one. Returns the new root.
 */
export function insertBeside(
  root: LayoutNode,
  pane: TerminalPane,
  dir: Direction,
  added: TerminalPane,
): LayoutNode {
  const target = findLeaf(root, pane);
  if (!target) return root;

  const parent = findParent(root, target);
  if (parent?.dir === dir) {
    target.share /= 2;
    parent.children.splice(parent.children.indexOf(target) + 1, 0, leaf(added, target.share));
    return root;
  }
  const branch: Branch = {
    kind: 'branch',
    dir,
    share: target.share,
    children: [leaf(pane), leaf(added)],
  };
  return replace(root, target, branch);
}

/** Drops a console from the tree. Returns the new root, or null if it was the last one. */
export function removeLeaf(root: LayoutNode, pane: TerminalPane): LayoutNode | null {
  const target = findLeaf(root, pane);
  if (!target) return root;
  if (root === target) return null;

  const parent = findParent(root, target)!;
  parent.children.splice(parent.children.indexOf(target), 1);
  return simplify(root);
}

/**
 * Canonical form: a branch left with one child becomes that child, and a branch
 * inside a branch that splits the same way is folded into it. Both keep the
 * geometry they had — only the depth of the tree changes.
 */
export function simplify(node: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') return node;

  const children: LayoutNode[] = [];
  for (const child of node.children.map(simplify)) {
    if (child.kind === 'branch' && child.dir === node.dir) {
      const total = sum(child.children) || 1;
      for (const grandchild of child.children) {
        grandchild.share = (grandchild.share / total) * child.share;
        children.push(grandchild);
      }
    } else {
      children.push(child);
    }
  }
  node.children = children;

  const only = children.length === 1 ? children[0]! : null;
  if (only) only.share = node.share;
  return only ?? node;
}

/**
 * Scales shares so they average 1. Flex hands out only part of the free space
 * when the factors sum below 1, which is what closing a pane would leave behind.
 */
export function normalized(children: LayoutNode[]): void {
  const total = sum(children);
  const scale = total > 0 ? children.length / total : 1;
  for (const child of children) child.share *= scale;
}

function sum(children: LayoutNode[]): number {
  return children.reduce((total, child) => total + child.share, 0);
}

function replace(root: LayoutNode, node: LayoutNode, next: LayoutNode): LayoutNode {
  if (root === node) return next;
  const parent = findParent(root, node);
  if (parent) parent.children[parent.children.indexOf(node)] = next;
  return root;
}
