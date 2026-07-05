type Meta = {
  model: string
  available_models?: string[]
  workspace: string
  base_dir: string
  user_workspace?: string
  user_workspace_abs?: string
}

type EnvironmentWidgetProps = {
  meta: Meta | null
  metaErr: string | null
  modelBusy: boolean
  modelErr: string | null
  shortPath: (p: string) => string
  onModelChange: (model: string) => void
}

export function EnvironmentWidget({
  meta,
  metaErr,
  modelBusy,
  modelErr,
  shortPath,
  onModelChange,
}: EnvironmentWidgetProps) {
  const models = meta?.available_models?.length ? meta.available_models : meta ? [meta.model] : []

  return (
    <div className="sidebar-section sidebar-widget">
      <h2>Environment</h2>
      {metaErr && <p className="warn">Could not load /api/meta ({metaErr}). Is the API running?</p>}
      {meta && (
        <dl className="meta-list">
          <div>
            <dt>Model</dt>
            <dd>
              {models.length > 0 ? (
                <select
                  className="workspace-select workspace-select-compact meta-model-select"
                  value={meta.model}
                  disabled={modelBusy || models.length <= 1}
                  aria-label="LLM model"
                  onChange={(e) => onModelChange(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                meta.model
              )}
            </dd>
            {modelErr && <p className="warn">{modelErr}</p>}
          </div>
          <div>
            <dt>Workspace</dt>
            <dd title={meta.workspace}>{shortPath(meta.workspace)}</dd>
          </div>
          <div>
            <dt>Base dir</dt>
            <dd title={meta.base_dir}>{shortPath(meta.base_dir)}</dd>
          </div>
          {meta.user_workspace && (
            <div>
              <dt>Your workspace</dt>
              <dd title={meta.user_workspace}>{shortPath(meta.user_workspace)}</dd>
            </div>
          )}
          {meta.user_workspace_abs && (
            <div>
              <dt>Your folder (disk)</dt>
              <dd title={meta.user_workspace_abs}>{shortPath(meta.user_workspace_abs)}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}
