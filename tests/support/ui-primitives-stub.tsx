/**
 * Test stub for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The published package's lib/ entry imports shiki and CSS modules, which the
 * vitest fork pool cannot load. Tests assert behavior, not styling, so these
 * stand-ins keep the same prop contract (className passthrough, children,
 * onClick/onChange) while rendering plain elements.
 */

import { createElement, type ReactNode } from 'react'

/** Minimal icon stand-in: a sized svg placeholder carrying the class hook. */
function icon(name: string) {
  return function IconStub({ size, className }: { size?: number; className?: string }) {
    return e2('svg', { 'data-icon': name, width: size, height: size, className })
  }
}
export const IconChevronDownOutlineRegular = icon('chevron-down')
export const IconInfoOutlineRegular = icon('info')
export const IconRefreshOutlineRegular = icon('refresh')

export function Button({ children, className, icon, ...rest }: { children?: ReactNode; className?: string; icon?: ReactNode; [key: string]: unknown }) {
  return createElement('button', { className, ...rest }, icon, children)
}

export function Tag({ children, className }: { children?: ReactNode; className?: string }) {
  return e2('span', { className }, children)
}

const e2 = createElement

export function StateDot({ className }: { className?: string }) {
  return createElement('span', { className })
}

export function DisclosureRow({ title, open, onToggle, children, className, titleClassName }: {
  title: string
  open: boolean
  onToggle: () => void
  children?: ReactNode
  className?: string
  titleClassName?: string
  [key: string]: unknown
}) {
  return e2('div', { className },
    e2('button', { type: 'button', className: titleClassName, 'aria-expanded': expandedOf(open), onClick: onToggle }, title),
    open ? e2('div', null, children) : null)
}

function expandedOf(open: boolean) {
  return open ? 'true' : 'false'
}

export function Modal({ open, title, description, children }: {
  open: boolean
  title?: string
  description?: ReactNode
  children?: ReactNode
  [key: string]: unknown
}) {
  return open ? e2('div', { role: 'dialog' },
    title !== undefined ? e2('h2', null, title) : null,
    description !== undefined ? e2('div', { className: 'arp-modal-description' }, description) : null,
    children) : null
}

export function SegmentedTabs({ items, value, onChange, className }: {
  items: readonly { value: string; label: ReactNode; id: string; panelId: string }[]
  value: string
  onChange: (value: never) => void
  label?: string
  className?: string
}) {
  return e2('div', { role: 'tablist', className },
    items.map(item => e2('button', {
      key: item.value,
      id: item.id,
      role: 'tab',
      'aria-selected': item.value === value ? 'true' : 'false',
      'aria-controls': item.panelId,
      'data-value': item.value,
      onClick: () => onChange(item.value as never),
    }, item.label)))
}

/** Structural stand-in for JsonTree: key/value rows without copy actions. */
export function JsonTree({ data, label }: { data: unknown; label?: string }) {
  const renderValue = (value: unknown): ReactNode =>
    value === null || typeof value !== 'object'
      ? String(value === undefined ? '—' : value)
      : e2('dl', { className: 'arp-json-stub' },
          Object.entries(value as Record<string, unknown>).map(([key, member]) => [
            e2('dt', { key: `${key}-t` }, key),
            e2('dd', { key: `${key}-d` },
              member === null || typeof member !== 'object' ? String(member) : JSON.stringify(member)),
          ]))
  return e2('div', { 'aria-label': label, className: 'arp-json' }, renderValue(data))
}

export function TextShimmer({ children }: { children?: ReactNode }) {
  return e2('span', null, children)
}

export function Menu({ open, anchor, items, selectedIds, onSelect }: {
  open: boolean
  anchor: ReactNode
  items?: readonly { id: string; label?: ReactNode }[]
  selectedIds?: readonly string[]
  onSelect?: (id: string) => void
  onClose?: () => void
  [key: string]: unknown
}) {
  return e2('span', { className: 'arp-menu' },
    anchor,
    open ? e2('div', { role: 'menu' },
      (items ?? []).map(item => e2('button', {
        key: item.id,
        type: 'button',
        role: 'menuitem',
        'aria-checked': selectedIds?.includes(item.id) ? 'true' : 'false',
        onClick: () => onSelect?.(item.id),
      }, item.label))) : null)
}
