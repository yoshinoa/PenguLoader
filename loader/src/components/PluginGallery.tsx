import { Component, For, createSignal, onMount, Switch, Match, Show, createEffect, onCleanup } from 'solid-js'
import { type PluginInfo, type AssetInfo, PluginManager } from '../lib/plugins'
import { LoaderIcon, ReloadIcon, StoreIcon } from './Icons'
import { Checkbox } from './ui'
import { useConfig } from '~/lib/config'
import { useRoot } from '~/lib/root'

type InstallMode = 'release' | 'source'
type InstallStep = 'idle' | 'loading-assets' | 'pick-asset' | 'installing' | 'success' | 'error'

function formatSize(bytes?: number) {
  if (bytes == null) return ''
  if (bytes >= 1024 * 1024) return ` — ${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return ` — ${(bytes / 1024).toFixed(0)} KB`
  return ` — ${bytes} B`
}

const PluginCard: Component<PluginInfo> = (props) => {
  const [enabled, setEnabled] = createSignal(PluginManager.isEnabled(props.hash))
  const toggle = () => {
    PluginManager.toggleState(props.hash).then(setEnabled)
  }
  return (
    <label draggable="false" class="flex flex-col gap-2 overflow-hidden shadow-md rounded-md border-solid bg-card border-[1px] border-neutral-600 hover:border-neutral-400">
      <div class="flex flex-col p-3 gap-2 items-stretch">
        <div class="flex items-center space-x-2">
          <Checkbox checked={enabled()} onClick={toggle} />
          <h3 class="font-semibold leading-7 text-base text-ellipsis whitespace-nowrap overflow-hidden">{props.name}</h3>
        </div>
        <div class="text-sm leading-5 text-muted-foreground break-words">@plugins/{props.path}</div>
      </div>
    </label>
  )
}

export const PluginGallery: Component = () => {

  const config = useConfig()
  const { setStore } = useRoot()

  const [loading, setLoading] = createSignal(false)
  const [plugins, setPlugins] = createSignal(Array<PluginInfo>(), { equals: false })

  const [installUrl, setInstallUrl] = createSignal('')
  const [installMode, setInstallMode] = createSignal<InstallMode>('release')
  const [installStep, setInstallStep] = createSignal<InstallStep>('idle')
  const [installError, setInstallError] = createSignal('')
  const [assets, setAssets] = createSignal<AssetInfo[]>([])

  let successTimer: ReturnType<typeof setTimeout> | undefined

  const resetInstall = () => {
    setInstallStep('idle')
    setInstallError('')
    setAssets([])
  }

  const handleInstall = async () => {
    const url = installUrl().trim()
    if (!url) return

    setInstallError('')

    if (installMode() === 'source') {
      setInstallStep('installing')
      try {
        await PluginManager.installPlugin(url, true)
        setInstallUrl('')
        setInstallStep('success')
        clearTimeout(successTimer)
        successTimer = setTimeout(resetInstall, 3000)
        reload()
      } catch (e: any) {
        setInstallError(String(e))
        setInstallStep('error')
      }
    } else {
      setInstallStep('loading-assets')
      try {
        const list = await PluginManager.fetchReleaseAssets(url)
        setAssets(list)
        setInstallStep('pick-asset')
      } catch (e: any) {
        setInstallError(String(e))
        setInstallStep('error')
      }
    }
  }

  const handlePickAsset = async (asset: AssetInfo) => {
    setInstallStep('installing')
    try {
      await PluginManager.installPlugin(installUrl().trim(), false, asset.downloadUrl, asset.isSource)
      setInstallUrl('')
      setAssets([])
      setInstallStep('success')
      clearTimeout(successTimer)
      successTimer = setTimeout(resetInstall, 3000)
      reload()
    } catch (e: any) {
      setInstallError(String(e))
      setInstallStep('error')
    }
  }

  onCleanup(() => clearTimeout(successTimer))

  const revealPlugins = () => {
    PluginManager.openFolder()
  }

  const reload = () => {
    setPlugins([])
    setLoading(true)

    Promise.all([
      PluginManager.getPlugins()
        .then(setPlugins)
        .catch(() => { }),
      new Promise((r) => setTimeout(r, 500))
    ])
      .finally(() => setLoading(false))
  }

  onMount(reload)
  createEffect(() => {
    config.app.plugins_dir()
    reload()
  })

  const busy = () => installStep() === 'loading-assets' || installStep() === 'installing'

  return (
    <div class="h-full">
      <Switch>
        <Match when={loading()}>
          <div class="text-accent-foreground m-auto flex flex-col items-center justify-center gap-2 h-full">
            <LoaderIcon class="animate-spin" />
            <p>Loading...</p>
          </div>
        </Match>
        <Match when={!loading()}>
          <div class="grid p-4">
            <h1 class="text-foreground/80 text-sm">Installed plugins ({plugins().length})</h1>

            {/* Install from URL */}
            <div class="mt-3 mb-1">
              <div class="flex gap-2">
                <input
                  type="text"
                  class="flex-1 min-w-0 text-sm bg-transparent border border-foreground/10 rounded-sm px-3 py-1 outline-none focus:border-foreground/30 placeholder:text-muted-foreground/50"
                  placeholder="Install from GitHub (https://github.com/user/repo)"
                  value={installUrl()}
                  onInput={e => { setInstallUrl(e.currentTarget.value); setInstallError(''); if (installStep() === 'error') setInstallStep('idle') }}
                  disabled={busy()}
                  onKeyDown={e => e.key === 'Enter' && handleInstall()}
                />
                {/* Release / Source toggle */}
                <div class="flex border border-foreground/10 rounded-sm text-sm overflow-hidden shrink-0">
                  <button
                    class="px-2 py-1 transition-colors"
                    classList={{ 'bg-foreground text-background': installMode() === 'release', 'hover:bg-foreground/10': installMode() !== 'release' }}
                    onClick={() => setInstallMode('release')}
                    disabled={busy()}
                  >
                    Release
                  </button>
                  <button
                    class="px-2 py-1 border-l border-foreground/10 transition-colors"
                    classList={{ 'bg-foreground text-background': installMode() === 'source', 'hover:bg-foreground/10': installMode() !== 'source' }}
                    onClick={() => setInstallMode('source')}
                    disabled={busy()}
                  >
                    Source
                  </button>
                </div>
                <button
                  class="inline-flex gap-1 items-center text-sm border border-foreground/10 rounded-sm px-3 py-1 hover:bg-foreground hover:text-background disabled:opacity-40 shrink-0"
                  onClick={handleInstall}
                  disabled={busy() || !installUrl().trim() || installStep() === 'pick-asset'}
                >
                  <Show when={busy()}>
                    <LoaderIcon size={14} class="animate-spin" />
                  </Show>
                  <Switch>
                    <Match when={installStep() === 'loading-assets'}>Fetching...</Match>
                    <Match when={installStep() === 'installing'}>Installing...</Match>
                    <Match when={true}>Install</Match>
                  </Switch>
                </button>
              </div>

              {/* Asset picker */}
              <Show when={installStep() === 'pick-asset'}>
                <div class="mt-2 border border-foreground/10 rounded-sm overflow-hidden">
                  <div class="flex items-center justify-between px-3 py-1.5 bg-foreground/5 border-b border-foreground/10">
                    <span class="text-xs text-muted-foreground">Pick a release asset to install</span>
                    <button class="text-xs text-muted-foreground hover:text-foreground" onClick={resetInstall}>Cancel</button>
                  </div>
                  <For each={assets()}>
                    {asset => (
                      <button
                        class="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-foreground/10 border-b border-foreground/5 last:border-0 text-left"
                        onClick={() => handlePickAsset(asset)}
                      >
                        <span>{asset.name}</span>
                        <span class="text-xs text-muted-foreground">{formatSize(asset.size)}{asset.isSource ? 'source' : ''}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={installStep() === 'error'}>
                <p class="text-xs text-red-400 mt-1">{installError()}</p>
              </Show>
              <Show when={installStep() === 'success'}>
                <p class="text-xs text-green-400 mt-1">Installed successfully!</p>
              </Show>
            </div>

            <Show
              when={plugins().length > 0}
              fallback={<h3 class="text-center my-8 w-full">You have no plugins!</h3>}
            >
              <div class="grid grid-cols-3 gap-x-4 my-4 gap-y-6">
                <For each={plugins()}>
                  {plugin => <PluginCard {...plugin} />}
                </For>
              </div>
            </Show>
            <div class="flex justify-evenly items-center w-full py-8">
              <div class="flex flex-col items-center space-y-4">
                <p class="text-sm text-secondary-foreground/70">Don't see your plugins?</p>
                <div class="flex gap-1">
                  <button
                    class="inline-flex gap-1 items-center text-sm border border-foreground/10 rounded-sm px-3 py-1 hover:bg-foreground hover:text-background"
                    tabIndex={-1}
                    onClick={reload}
                  >
                    <ReloadIcon size={14} /> Reload
                  </button>
                  <button
                    class="inline-flex gap-1 items-center text-sm border border-foreground/10 rounded-sm px-3 py-1 hover:bg-foreground hover:text-background"
                    tabIndex={-1}
                    onClick={revealPlugins}
                  >
                    Open folder
                  </button>
                </div>
              </div>
              <div class="flex flex-col items-center space-y-4">
                <p class="text-sm text-secondary-foreground/70">More plugins?</p>
                <button
                  class="inline-flex gap-1 items-center text-sm border border-foreground/10 rounded-sm px-3 py-1 hover:bg-foreground hover:text-background"
                  tabIndex={-1}
                  onClick={() => setStore(true)}
                >
                  <StoreIcon size={14} /> Get in Store
                </button>
              </div>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
