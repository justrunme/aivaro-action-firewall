/**
 * A tiny DOM, just enough for the Console's `h()` helper and its screens to build a
 * tree under Node: elements with children, attributes, class names and listeners.
 * Written for test/console-ui.test.js; it is not a browser and checks no layout.
 */
export class FakeNode {}

export class FakeText extends FakeNode {
  constructor(text) {
    super()
    this.text = String(text)
  }

  get textContent() {
    return this.text
  }
}

export class FakeElement extends FakeNode {
  constructor(tag) {
    super()
    this.tag = tag
    this.children = []
    this.attrs = {}
    this.className = ''
    this.style = {}
    this.listeners = {}
    this.value = ''
    this.disabled = false
  }

  get textContent() {
    return this.children.map((c) => c.textContent).join('')
  }

  set textContent(v) {
    this.children = [new FakeText(v)]
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }

  getAttribute(k) {
    return this.attrs[k] ?? null
  }

  append(...kids) {
    for (const k of kids) this.children.push(typeof k === 'string' ? new FakeText(k) : k)
  }

  replaceChildren(...kids) {
    this.children = []
    this.append(...kids)
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  remove() {}
}

/** Install `document` and `Node` on globalThis; returns a function that removes them. */
export function installFakeDom() {
  const saved = { document: globalThis.document, Node: globalThis.Node }
  globalThis.Node = FakeNode
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeText(t),
  }
  return () => {
    globalThis.document = saved.document
    globalThis.Node = saved.Node
    if (saved.document === undefined) delete globalThis.document
    if (saved.Node === undefined) delete globalThis.Node
  }
}

/** Every element below `node` (and `node` itself) for which `pred` holds. */
export function findAll(node, pred, out = []) {
  if (node instanceof FakeElement) {
    if (pred(node)) out.push(node)
    for (const c of node.children) findAll(c, pred, out)
  }
  return out
}

export const hasClass = (el, name) => el.className.split(/\s+/).includes(name)
