export type SidebarWidgetsState = {
  account: boolean
  diagnose: boolean
  proposal: boolean
  connectivity: boolean
  environment: boolean
  workspaceFiles: boolean
}

export const DEFAULT_SIDEBAR_WIDGETS: SidebarWidgetsState = {
  account: true,
  diagnose: true,
  proposal: true,
  connectivity: true,
  environment: true,
  workspaceFiles: true,
}

export function parseSidebarWidgets(raw: unknown): SidebarWidgetsState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SIDEBAR_WIDGETS }
  const o = raw as Record<string, unknown>
  const b = (k: keyof SidebarWidgetsState) =>
    typeof o[k] === 'boolean' ? o[k] : DEFAULT_SIDEBAR_WIDGETS[k]
  return {
    account: b('account'),
    diagnose: b('diagnose'),
    proposal: b('proposal'),
    connectivity: b('connectivity'),
    environment: b('environment'),
    workspaceFiles: b('workspaceFiles'),
  }
}
