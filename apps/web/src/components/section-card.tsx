import type { ReactNode } from 'react'
import { Surface } from './ui/surface'
import styles from './ui/surfaces.module.css'
export function SectionCard({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Surface>
      {action ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <h2 className="m-0 text-base leading-6 font-medium">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{action}</div>
        </div>
      ) : (
        <h2 className={styles.sectionTitle}>{title}</h2>
      )}
      {children}
    </Surface>
  )
}
