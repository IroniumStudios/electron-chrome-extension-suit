import * as electron from 'electron';
import { ExtensionContext } from '../context';
import { ExtensionEvent } from '../router';

const debug = require('debug')('electron-chrome-extensions:webNavigation');

// https://github.com/electron/electron/pull/25464
const getFrame = (frameProcessId: number, frameRoutingId: number) => {
    return (
        ('webFrameMain' in electron &&
            (electron as any).webFrameMain.fromId(
                frameProcessId,
                frameRoutingId
            )) ||
        null
    );
};

const getFrameId = (frame: any) =>
    'webFrameMain' in electron
        ? frame === frame.top
            ? 0
            : frame.frameTreeNodeId
        : -1;

const getParentFrameId = (frame: any) => {
    const parentFrame = frame?.parent;
    return parentFrame ? getFrameId(parentFrame) : -1;
};

const getFrameDetails = (frame: any) => ({
    errorOccurred: false, // TODO
    processId: frame?.processId ?? -1,
    frameId: frame ? getFrameId(frame) : -1,
    parentFrameId: frame ? getParentFrameId(frame) : -1,
    url: frame?.url || '',
});

export class WebNavigationAPI {
    constructor(private ctx: ExtensionContext) {
        const handle = this.ctx.router.apiHandler();
        handle('webNavigation.getFrame', this.getFrame.bind(this));
        handle('webNavigation.getAllFrames', this.getAllFrames.bind(this));

        this.ctx.store.on('tab-added', this.observeTab.bind(this));
    }

    private observeTab(tab: Electron.WebContents) {
        tab.once('will-navigate', this.onCreatedNavigationTarget as any);
        tab.on('did-start-navigation', this.onBeforeNavigate as any);
        tab.on('did-frame-finish-load', this.onFinishLoad as any);
        tab.on('did-frame-navigate', this.onCommitted as any);
        tab.on('did-navigate-in-page', this.onHistoryStateUpdated as any);

        tab.on('frame-created', (e, { frame }) => {
        //  TODO: fix null calling so it dosent errer out.
        //    if (frame.top === frame) return;

        //    frame.on('dom-ready', () => {
        //        if (frame) this.onDOMContentLoaded(tab, frame);
        //    });
        });

        // Main frame dom-ready event
        tab.on('dom-ready', () => {
            if ('mainFrame' in tab && tab.mainFrame) {
                this.onDOMContentLoaded(tab, tab.mainFrame);
            }
        });
    }

    private getFrame(
        event: ExtensionEvent,
        details: chrome.webNavigation.GetFrameDetails
    ): chrome.webNavigation.GetFrameResultDetails | null {
        const tab = this.ctx.store.getTabById(details.tabId);
        if (!tab) return null;

        let targetFrame: any;

        if (typeof details.frameId === 'number') {
            // https://github.com/electron/electron/pull/25464
            if ('mainFrame' in tab) {
                const mainFrame = (tab as any).mainFrame;
                targetFrame = mainFrame.framesInSubtree.find((frame: any) => {
                    const isMainFrame = frame === frame.top;
                    return isMainFrame
                        ? details.frameId === 0
                        : details.frameId === frame.frameTreeNodeId;
                });
            }
        }

        return targetFrame ? getFrameDetails(targetFrame) : null;

        function getFrameDetails(frame: any): chrome.webNavigation.GetFrameResultDetails {
            return {
                errorOccurred: frame.errorOccurred,
                parentFrameId: frame.parentFrameId,
                url: frame.url,
                documentId: frame.documentId, // Replace with actual value
                documentLifecycle: frame.documentLifecycle, // Replace with actual value
                frameType: frame.frameType // Replace with actual value
            };
        }
    }

    private getAllFrames(
        event: ExtensionEvent,
        details: chrome.webNavigation.GetFrameDetails
    ): chrome.webNavigation.GetAllFrameResultDetails[] | null {
        const tab = this.ctx.store.getTabById(details.tabId);
        if (!tab || !('mainFrame' in tab)) return [];
        return (tab as any).mainFrame.framesInSubtree.map(getFrameDetails);
    }

    private sendNavigationEvent = (
        eventName: string,
        details: { url: string }
    ) => {
        debug(`${eventName} [url: ${details.url}]`);
        this.ctx.router.broadcastEvent(`webNavigation.${eventName}`, details);
    };

    private onCreatedNavigationTarget = (
        event: Electron.IpcMainEvent,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
    ) => {
        const frame = getFrame(frameProcessId, frameRoutingId);
        const tab = event.sender;
        const details: chrome.webNavigation.WebNavigationSourceCallbackDetails =
            {
                sourceTabId: tab?.id,
                sourceProcessId: frameProcessId,
                sourceFrameId: frame ? getFrameId(frame) : -1,
                url,
                tabId: tab?.id,
                timeStamp: Date.now(),
            };
        this.sendNavigationEvent('onCreatedNavigationTarget', details);
    };

    private onBeforeNavigate = (
        event: Electron.IpcMainEvent,
        url: string,
        isInPlace: number,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
    ) => {
        if (isInPlace) return;

        const frame = getFrame(frameProcessId, frameRoutingId);
        const tab = event.sender;
        const details: chrome.webNavigation.WebNavigationParentedCallbackDetails =
            {
                frameId: frame ? getFrameId(frame) : -1,
                parentFrameId: frame ? getParentFrameId(frame) : -1,
                processId: frameProcessId,
                tabId: tab?.id,
                timeStamp: Date.now(),
                url,
                frameType: 'outermost_frame',
                documentLifecycle: 'prerender'
            };

        this.sendNavigationEvent('onBeforeNavigate', details);
    };

    private onCommitted = (
        event: Electron.IpcMainEvent,
        url: string,
        httpResponseCode: number,
        httpStatusText: string,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
    ) => {
        const frame = getFrame(frameProcessId, frameRoutingId);
        const tab = event.sender;
        const details: chrome.webNavigation.WebNavigationParentedCallbackDetails =
            {
                frameId: frame ? getFrameId(frame) : -1,
                parentFrameId: frame ? getParentFrameId(frame) : -1,
                processId: frameProcessId,
                tabId: tab?.id,
                timeStamp: Date.now(),
                url,
                frameType: 'outermost_frame',
                documentLifecycle: 'prerender'
            };
        this.sendNavigationEvent('onCommitted', details);
    };

    private onHistoryStateUpdated = (
        event: Electron.IpcMainEvent,
        url: string,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
      ) => {
        const frame = getFrame(frameProcessId, frameRoutingId);
        const tab = event.sender;
        const details: chrome.webNavigation.WebNavigationTransitionCallbackDetails & {
          parentFrameId: number;
          frameType: string;
          documentLifecycle: string[];
        } = {
          transitionType: '', // TODO
          transitionQualifiers: [], // TODO
          frameId: frame ? getFrameId(frame) : -1,
          parentFrameId: frame ? getParentFrameId(frame) : -1,
          processId: frameProcessId,
          tabId: tab.id,
          timeStamp: Date.now(),
          url,
          frameType: frame?.frameType || 'other',
          documentLifecycle: frame?.documentLifecycle || [],
        };
        this.sendNavigationEvent('onHistoryStateUpdated', details);
      };  

    private onDOMContentLoaded = (
        tab: Electron.WebContents,
        frame: Electron.WebFrameMain
    ) => {
        const details: chrome.webNavigation.WebNavigationParentedCallbackDetails =
            {
                frameId: getFrameId(frame),
                parentFrameId: getParentFrameId(frame),
                processId: frame.processId,
                tabId: tab?.id,
                timeStamp: Date.now(),
                url: frame.url,
                frameType: 'outermost_frame',
                documentLifecycle: 'prerender'
            };
        this.sendNavigationEvent('onDOMContentLoaded', details);

        if (!tab.isLoadingMainFrame()) {
            this.sendNavigationEvent('onCompleted', details);
        }
    };

    private onFinishLoad = (
        event: Electron.IpcMainEvent,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
    ) => {
        const frame = getFrame(frameProcessId, frameRoutingId);
        const tab = event.sender;
        const url = tab?.getURL();
        const details: chrome.webNavigation.WebNavigationParentedCallbackDetails =
            {
                frameId: frame ? getFrameId(frame) : -1,
                parentFrameId: frame ? getParentFrameId(frame) : -1,
                processId: frameProcessId,
                tabId: tab?.id,
                timeStamp: Date.now(),
                url,
                frameType: 'outermost_frame',
                documentLifecycle: 'prerender'
            };
        this.sendNavigationEvent('onCompleted', details);
    };
}
