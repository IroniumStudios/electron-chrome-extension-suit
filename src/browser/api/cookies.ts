import { ExtensionContext } from '../context';
import { ExtensionEvent } from '../router';

enum CookieStoreID {
    Default = '0',
    Incognito = '1',
}

// Custom types to match chrome.cookies.Details structure
type CookieDetails = {
    url: string;
    name: string;
};

type GetAllCookieDetails = CookieDetails & {
    domain?: string;
    path?: string;
    secure?: boolean;
    session?: boolean;
};

// Define a type to match the cookies.set expected structure with required url
type CookiesSetDetails = {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'no_restriction' | 'lax' | 'strict';
    expirationDate?: number;
    storeId?: string;
};

const onChangedCauseTranslation: { [key: string]: string } = {
    'expired-overwrite': 'expired_overwrite',
};

const createCookieDetails = (cookie: Electron.Cookie): chrome.cookies.Cookie => ({
    ...cookie,
    domain: cookie.domain || '',
    hostOnly: Boolean(cookie.hostOnly),
    session: Boolean(cookie.session),
    path: cookie.path || '',
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    storeId: CookieStoreID.Default,
});

export class CookiesAPI {
    private get cookies() {
        return this.ctx.session.cookies;
    }

    constructor(private ctx: ExtensionContext) {
        const handle = this.ctx.router.apiHandler();
        handle('cookies.get', this.get.bind(this));
        handle('cookies.getAll', this.getAll.bind(this));
        handle('cookies.set', this.set.bind(this));
        handle('cookies.remove', this.remove.bind(this));
        handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this));

        this.cookies.addListener('changed', this.onChanged);
    }

    private async get(event: ExtensionEvent, details: CookieDetails): Promise<chrome.cookies.Cookie | null> {
        const cookies = await this.cookies.get({
            url: details.url,
            name: details.name,
        });
        return cookies.length > 0 ? createCookieDetails(cookies[0]) : null;
    }

    private async getAll(event: ExtensionEvent, details: GetAllCookieDetails): Promise<chrome.cookies.Cookie[]> {
        const cookies = await this.cookies.get(details);
        return cookies.map(createCookieDetails);
    }

    private async set(event: ExtensionEvent, details: CookiesSetDetails): Promise<chrome.cookies.Cookie | null> {
        await this.cookies.set(details);
        const cookies = await this.cookies.get({ url: details.url, name: details.name });
        return cookies.length > 0 ? createCookieDetails(cookies[0]) : null;
    }

    private async remove(event: ExtensionEvent, details: CookieDetails): Promise<CookieDetails | null> {
        try {
            await this.cookies.remove(details.url, details.name);
            return details;
        } catch {
            return null;
        }
    }

    private async getAllCookieStores(event: ExtensionEvent): Promise<chrome.cookies.CookieStore[]> {
        const tabIds = Array.from(this.ctx.store.tabs)
            .map((tab) => (tab.isDestroyed() ? undefined : tab.id))
            .filter(Boolean) as number[];
        return [{ id: CookieStoreID.Default, tabIds }];
    }

    private onChanged = (
        event: { preventDefault: () => void; readonly defaultPrevented: boolean },
        cookie: Electron.Cookie,
        cause: string,
        removed: boolean
    ) => {
        const changeInfo: chrome.cookies.CookieChangeInfo = {
            cause: onChangedCauseTranslation[cause] || cause,
            cookie: createCookieDetails(cookie),
            removed,
        };
        this.ctx.router.broadcastEvent('cookies.onChanged', changeInfo);
    };
}
