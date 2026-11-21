import { cva } from 'class-variance-authority'
import styles from './primitives/Button.module.css'

/** Shared button styles including links styled as buttons. */
export const buttonVariants = cva([styles.button, '[&_svg]:size-4 [&_svg]:shrink-0'], {
  variants: {
    variant: {
      default: styles.primary,
      outline: styles.outline,
      secondary: styles.outline,
      ghost: styles.ghost,
      destructive: [styles.outline, 'text-status-danger-fg'],
      link: [styles.ghost, 'text-link'],
    },
    size: {
      default: styles.md,
      sm: styles.sm,
      lg: styles.md,
      xl: styles.md,
      icon: [styles.md, 'size-9 p-0'],
      'icon-xs': [styles.sm, 'size-7 p-0'],
      'icon-sm': [styles.sm, 'size-7 p-0'],
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
})
