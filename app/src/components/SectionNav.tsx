import { NavLink } from 'react-router'

// Sections of one page that each have their own URL: links styled as tabs, marked with aria-current.
export function SectionNav({ label, items }: { label: string; items: { to: string; label: string }[] }) {
  return <nav className="ui-tabs" aria-label={label}>{items.map(item => <NavLink key={item.to} to={item.to} end className="ui-tab">{item.label}</NavLink>)}</nav>
}
