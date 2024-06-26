import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { EventEmitter } from 'events'

export const injectBrowserAction = () => {
  const actionMap = new Map<string, any>()
  const internalEmitter = new EventEmitter()
  const observerCounts = new Map<string, number>()

  const invoke = <T>(name: string, partition: string, ...args: any[]): Promise<T> => {
    return ipcRenderer.invoke('crx-msg-remote', partition, name, ...args)
  }

  interface ActivateDetails {
    eventType: string
    extensionId: string
    tabId: number
    anchorRect: { x: number; y: number; width: number; height: number }
  }

  const browserAction = {
    addEventListener(name: string, listener: (...args: any[]) => void) {
      internalEmitter.addListener(name, listener)
    },
    removeEventListener(name: string, listener: (...args: any[]) => void) {
      internalEmitter.removeListener(name, listener)
    },

    getAction(extensionId: string) {
      return actionMap.get(extensionId)
    },
    async getState(partition: string): Promise<{ activeTabId?: number; actions: any[] }> {
      const state = await invoke<any>('browserAction.getState', partition)
      for (const action of state.actions) {
        actionMap.set(action.id, action)
      }
      queueMicrotask(() => internalEmitter.emit('update', state))
      return state
    },

    activate: (partition: string, details: ActivateDetails) => {
      return invoke('browserAction.activate', partition, details)
    },

    addObserver(partition: string) {
      let count = observerCounts.has(partition) ? observerCounts.get(partition)! : 0
      count = count + 1
      observerCounts.set(partition, count)

      if (count === 1) {
        invoke('browserAction.addObserver', partition)
      }
    },
    removeObserver(partition: string) {
      let count = observerCounts.has(partition) ? observerCounts.get(partition)! : 0
      count = Math.max(count - 1, 0)
      observerCounts.set(partition, count)

      if (count === 0) {
        invoke('browserAction.removeObserver', partition)
      }
    },

    // New methods for tooltips
    setTooltip(extensionId: string, tooltip: string) {
      const action = actionMap.get(extensionId)
      if (action) {
        action.tooltip = tooltip
        internalEmitter.emit('update', { actions: Array.from(actionMap.values()) })
      }
    },
    getTooltip(extensionId: string): string | undefined {
      const action = actionMap.get(extensionId)
      return action?.tooltip
    },

    // New methods for enabling/disabling actions
    enableAction(extensionId: string) {
      const action = actionMap.get(extensionId)
      if (action) {
        action.enabled = true
        internalEmitter.emit('update', { actions: Array.from(actionMap.values()) })
      }
    },
    disableAction(extensionId: string) {
      const action = actionMap.get(extensionId)
      if (action) {
        action.enabled = false
        internalEmitter.emit('update', { actions: Array.from(actionMap.values()) })
      }
    },

    // New methods for dynamic visibility
    setVisibility(extensionId: string, visible: boolean) {
      const action = actionMap.get(extensionId)
      if (action) {
        action.visible = visible
        internalEmitter.emit('update', { actions: Array.from(actionMap.values()) })
      }
    },

    // New methods for action priorities
    setPriority(extensionId: string, priority: number) {
      const action = actionMap.get(extensionId)
      if (action) {
        action.priority = priority
        internalEmitter.emit('update', { actions: Array.from(actionMap.values()) })
      }
    }
  }

  ipcRenderer.on('browserAction.update', () => {
    for (const partition of observerCounts.keys()) {
      browserAction.getState(partition)
    }
  })

  // Function body to run in the main world.
  // IMPORTANT: This must be self-contained, no closure variables can be used!
  function mainWorldScript(bA: typeof browserAction) {
    const DEFAULT_PARTITION = '_self'

    class BrowserActionElement extends HTMLButtonElement {
      private updateId?: number
      private badge?: HTMLDivElement
      private pendingIcon?: HTMLImageElement

      get id(): string {
        return this.getAttribute('id') || ''
      }

      set id(id: string) {
        this.setAttribute('id', id)
      }

      get tab(): number {
        const tabId = parseInt(this.getAttribute('tab') || '', 10)
        return typeof tabId === 'number' && !isNaN(tabId) ? tabId : -1
      }

      set tab(tab: number) {
        this.setAttribute('tab', `${tab}`)
      }

      get partition(): string | null {
        return this.getAttribute('partition')
      }

      set partition(partition: string | null) {
        if (partition) {
          this.setAttribute('partition', partition)
        } else {
          this.removeAttribute('partition')
        }
      }

      static get observedAttributes() {
        return ['id', 'tab', 'partition']
      }

      constructor() {
        super()

        this.addEventListener('click', this.onClick.bind(this))
        this.addEventListener('contextmenu', this.onContextMenu.bind(this))
        this.addEventListener('mouseover', this.onHover.bind(this))  // Hover event listener
        this.addEventListener('keydown', this.onKeyDown.bind(this))  // Keyboard navigation support
      }

      connectedCallback() {
        if (this.isConnected) {
          this.update()
        }
      }

      disconnectedCallback() {
        if (this.updateId) {
          cancelAnimationFrame(this.updateId)
          this.updateId = undefined
        }
        if (this.pendingIcon) {
          this.pendingIcon = undefined
        }
      }

      attributeChangedCallback() {
        if (this.isConnected) {
          this.update()
        }
      }

      private activate(event: Event) {
        const rect = this.getBoundingClientRect()

        bA.activate(this.partition || DEFAULT_PARTITION, {
          eventType: event.type,
          extensionId: this.id,
          tabId: this.tab,
          anchorRect: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
        })
      }

      private onClick(event: MouseEvent) {
        this.activate(event)
      }

      private onContextMenu(event: MouseEvent) {
        event.stopImmediatePropagation()
        event.preventDefault()

        this.activate(event)
      }

      private onHover(event: MouseEvent) {
        // Custom logic for hover event
        console.log(`Action hovered: ${this.id}`)
        // Optionally, you can emit an event or perform other actions
      }

      private onKeyDown(event: KeyboardEvent) {
        if (event.key === 'Enter' || event.key === ' ') {
          this.activate(event)
        }
      }

      private getBadge() {
        let badge = this.badge
        if (!badge) {
          this.badge = badge = document.createElement('div')
          badge.className = 'badge'
          ;(badge as any).part = 'badge'
          this.appendChild(badge)

          // Add event listener for badge click
          badge.addEventListener('click', (event) => {
            event.stopImmediatePropagation()
            bA.addEventListener('badgeClick', () => {
              // Custom logic for badge click event
              console.log(`Badge clicked for action: ${this.id}`)
            })
          })
        }
        return badge
      }

      private update() {
        if (this.updateId) return
        this.updateId = requestAnimationFrame(this.updateCallback.bind(this))
      }

      private updateIcon(info: any) {
        const iconSize = 32
        const resizeType = 2
        const timeParam = info.iconModified ? `&t=${info.iconModified}` : ''
        const iconUrl = `crx://extension-icon/${this.id}/${iconSize}/${resizeType}?tabId=${this.tab}${timeParam}`
        const bgImage = `url(${iconUrl})`

        if (this.pendingIcon) {
          this.pendingIcon = undefined
        }

        // Preload icon to prevent it from blinking
        const img = (this.pendingIcon = new Image())
        img.onload = () => {
          if (this.isConnected) {
            this.style.backgroundImage = bgImage
            this.pendingIcon = undefined
          }
        }
        img.src = iconUrl
      }

      private updateCallback() {
        this.updateId = undefined

        const action = bA.getAction(this.id)

        const activeTabId = this.tab
        const tabInfo = activeTabId > -1 ? action.tabs[activeTabId] : {}
        const info = { ...tabInfo, ...action }

        this.title = typeof info.title === 'string' ? info.title : ''
        this.title = bA.getTooltip(this.id) || this.title // Set tooltip if available

        this.updateIcon(info)

        if (info.text) {
          const badge = this.getBadge()
          badge.textContent = info.text
          badge.style.color = info.textColor || '#fff' // Default to white if no color specified
          badge.style.backgroundColor = info.color || 'rgba(0, 0, 0, 0.7)' // Default to semi-transparent black if no color specified
        } else if (this.badge) {
          this.badge.remove()
          this.badge = undefined
        }

        // Set enabled/disabled state
        this.disabled = !info.enabled

        // Set visibility
        this.style.display = info.visible ? 'block' : 'none'
      }
    }

    customElements.define('browser-action', BrowserActionElement, { extends: 'button' })

    class BrowserActionListElement extends HTMLElement {
      private observing: boolean = false

      get tab(): number | null {
        const tabId = parseInt(this.getAttribute('tab') || '', 10)
        return typeof tabId === 'number' && !isNaN(tabId) ? tabId : null
      }

      set tab(tab: number | null) {
        if (typeof tab === 'number') {
          this.setAttribute('tab', `${tab}`)
        } else {
          this.removeAttribute('tab')
        }
      }

      get partition(): string | null {
        return this.getAttribute('partition')
      }

      set partition(partition: string | null) {
        if (partition) {
          this.setAttribute('partition', partition)
        } else {
          this.removeAttribute('partition')
        }
      }

      static get observedAttributes() {
        return ['tab', 'partition']
      }

      constructor() {
        super()

        const shadowRoot = this.attachShadow({ mode: 'open' })

        const style = document.createElement('style')
        style.textContent = `
:host {
  display: flex;
  flex-direction: row;
  gap: 5px;
}

.action {
  width: 28px;
  height: 28px;
  background-color: transparent;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 70%;
  border: none;
  border-radius: 4px;
  padding: 0;
  position: relative;
  outline: none;
}

.action:hover {
  background-color: var(--browser-action-hover-bg, rgba(255, 255, 255, 0.3));
}

.badge {
  box-shadow: 0px 0px 1px 1px var(--browser-action-badge-outline, #444);
  box-sizing: border-box;
  max-width: 100%;
  height: 12px;
  padding: 0 2px;
  border-radius: 2px;
  position: absolute;
  bottom: 1px;
  right: 0;
  pointer-events: none;
  line-height: 1.5;
  font-size: 9px;
  font-weight: 400;
  overflow: hidden;
  white-space: nowrap;
}`
        shadowRoot.appendChild(style)
      }

      connectedCallback() {
        if (this.isConnected) {
          this.startObserving()
          this.fetchState()
        }
      }

      disconnectedCallback() {
        this.stopObserving()
      }

      attributeChangedCallback(name: string, oldValue: any, newValue: any) {
        if (oldValue === newValue) return

        if (this.isConnected) {
          this.fetchState()
        }
      }

      private startObserving() {
        if (this.observing) return
        bA.addEventListener('update', this.update)
        bA.addObserver(this.partition || DEFAULT_PARTITION)
        this.observing = true
      }

      private stopObserving() {
        if (!this.observing) return
        bA.removeEventListener('update', this.update)
        bA.removeObserver(this.partition || DEFAULT_PARTITION)
        this.observing = false
      }

      private fetchState = async () => {
        try {
          await bA.getState(this.partition || DEFAULT_PARTITION)
        } catch {
          console.error(
            `browser-action-list failed to update [tab: ${this.tab}, partition: '${this.partition}']`
          )
        }
      }

      private update = (state: any) => {
        const tabId =
          typeof this.tab === 'number' && this.tab >= 0 ? this.tab : state.activeTabId || -1

        // Sort actions by priority
        const sortedActions = state.actions.sort((a: any, b: any) => b.priority - a.priority)

        for (const action of sortedActions) {
          let browserActionNode = this.shadowRoot?.querySelector(
            `[id=${action.id}]`
          ) as BrowserActionElement

          if (!browserActionNode) {
            const node = document.createElement('button', {
              is: 'browser-action',
            }) as BrowserActionElement
            node.id = action.id
            node.className = 'action'
            ;(node as any).part = 'action'
            browserActionNode = node
            this.shadowRoot?.appendChild(browserActionNode)
          }

          if (this.partition) browserActionNode.partition = this.partition
          browserActionNode.tab = tabId
        }
      }
    }

    customElements.define('browser-action-list', BrowserActionListElement)
  }

  try {
    contextBridge.exposeInMainWorld('browserAction', browserAction)

    // Must execute script in main world to modify custom component registry.
    webFrame.executeJavaScript(`(${mainWorldScript}(browserAction));`)
  } catch {
    // When contextIsolation is disabled, contextBridge will throw an error.
    // If that's the case, we're in the main world so we can just execute our
    // function.
    mainWorldScript(browserAction)
  }
}
