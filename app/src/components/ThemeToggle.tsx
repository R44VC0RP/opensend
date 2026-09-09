import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { IconButton } from './ui'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  return <IconButton className="theme-toggle" variant="ghost" size="sm" label={label} title={label} onClick={toggleTheme}>
    {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
  </IconButton>
}
