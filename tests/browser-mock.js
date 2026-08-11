"use strict";
/* A minimal but faithful mock of the WebExtension `browser` API surface used
   by scripts/utils.js and scripts/background.js, for Node-based unit tests. */

function makeBrowserMock() {
	const localData = {};
	const sessionData = {};
	const grantedPermissions = new Set();
	const grantedOrigins = new Set();
	let cookiesStore = [];           // [{name, value, domain}]
	let cookieRequestPermission = true; // what permissions.request() answers
	const dynamicRules = [];         // [{id, action, condition}]
	const createdMenuItems = [];
	const sentTabMessages = [];      // {tabId, message}
	const openedTabs = [];           // urls passed to tabs.create
	let tabs = [];                   // [{id, url}]

	const emitter = () => {
		const fns = [];
		return {
			addListener: fn => fns.push(fn),
			trigger: (...args) => Promise.all(fns.map(fn => fn(...args))),
			fns,
		};
	};

	const fireChanges = (listeners, area) => listeners.trigger({}, area);

	const localChanged = emitter();
	const sessionChanged = emitter();
	const runtimeMessage = emitter();
	const tabsUpdated = emitter();
	const tabsRemoved = emitter();
	const contextShown = emitter();
	const contextHidden = emitter();
	const contextClicked = emitter();
	const permsAdded = emitter();
	const permsRemoved = emitter();
	const cookiesChanged = emitter();

	const pick = (data, keys) => {
		if (keys === undefined || keys === null) return {...data};
		const list = Array.isArray(keys) ? keys : [keys];
		const out = {};
		for (const k of list) if (k in data) out[k] = data[k];
		return out;
	};

	const browser = {
		storage: {
			local: {
				get: keys => Promise.resolve(pick(localData, keys)),
				set: obj => {
					for (const k in obj) localData[k] = obj[k];
					return fireChanges(localChanged, "local");
				},
				remove: keys => {
					for (const k of (Array.isArray(keys) ? keys : [keys])) delete localData[k];
					return fireChanges(localChanged, "local");
				},
				clear: () => {
					for (const k in localData) delete localData[k];
					return fireChanges(localChanged, "local");
				},
				onChanged: localChanged,
			},
			session: {
				get: keys => Promise.resolve(pick(sessionData, keys)),
				set: obj => {
					for (const k in obj) sessionData[k] = obj[k];
					return fireChanges(sessionChanged, "session");
				},
				clear: () => {
					for (const k in sessionData) delete sessionData[k];
					return fireChanges(sessionChanged, "session");
				},
				onChanged: sessionChanged,
			},
		},
		permissions: {
			contains: q => {
				const permsOk = (q.permissions ?? []).every(p => grantedPermissions.has(p));
				const origOk = (q.origins ?? []).every(o => grantedOrigins.has(o) || grantedOrigins.has("<all_urls>"));
				return Promise.resolve(permsOk && origOk);
			},
			request: q => {
				if (!cookieRequestPermission) return Promise.resolve(false);
				(q.permissions ?? []).forEach(p => grantedPermissions.add(p));
				(q.origins ?? []).forEach(o => grantedOrigins.add(o));
				permsAdded.trigger({permissions: q.permissions ?? [], origins: q.origins ?? []});
				return Promise.resolve(true);
			},
			onAdded: permsAdded,
			onRemoved: permsRemoved,
		},
		declarativeNetRequest: {
			updateDynamicRules: ({removeRuleIds = [], addRules = []}) => {
				for (const id of removeRuleIds) {
					const i = dynamicRules.findIndex(r => r.id === id);
					if (i >= 0) dynamicRules.splice(i, 1);
				}
				for (const rule of addRules) {
					if (dynamicRules.some(r => r.id === rule.id)) return Promise.reject(new Error("duplicate rule id " + rule.id));
					dynamicRules.push(rule);
				}
				return Promise.resolve();
			},
			getDynamicRules: () => Promise.resolve(dynamicRules.map(r => ({...r}))),
		},
		contextMenus: {
			create: item => { createdMenuItems.push(item); return Promise.resolve(item.id); },
			removeAll: () => { createdMenuItems.length = 0; return Promise.resolve(); },
			refresh: () => Promise.resolve(),
			onShown: contextShown,
			onHidden: contextHidden,
			onClicked: contextClicked,
		},
		tabs: {
			onUpdated: tabsUpdated,
			onRemoved: tabsRemoved,
			sendMessage: (tabId, message) => { sentTabMessages.push({tabId, message}); return Promise.resolve({}); },
			query: () => Promise.resolve(tabs.map(t => ({...t}))),
			reload: id => Promise.resolve(),
			create: props => { openedTabs.push(props.url); return Promise.resolve({id: 9999}); },
		},
		runtime: {
			onMessage: runtimeMessage,
			sendMessage: () => Promise.resolve({}),
			getURL: p => "moz-extension://test/" + p,
			reload: () => Promise.resolve(),
		},
		cookies: {
			getAll: ({domain}) => Promise.resolve(cookiesStore.filter(c => {
				const d = c.domain.replace(/^\./, "");
				return d === domain || d.endsWith("." + domain);
			})),
			onChanged: cookiesChanged,
		},
	};

	return {
		browser,
		// test helpers
		localData, sessionData, dynamicRules, createdMenuItems, sentTabMessages, openedTabs,
		grantedPermissions, grantedOrigins,
		setCookies: list => { cookiesStore = list; },
		setCookieRequestPermission: v => { cookieRequestPermission = v; },
		setTabs: list => { tabs = list; },
		dispatchRuntime: (message, sender) => runtimeMessage.trigger(message, sender).then(rs => rs.find(r => r !== undefined)),
		fireTabsUpdated: (...a) => tabsUpdated.trigger(...a),
		fireTabsRemoved: (...a) => tabsRemoved.trigger(...a),
		fireContextClicked: (...a) => contextClicked.trigger(...a),
		fireContextShown: (...a) => contextShown.trigger(...a),
		firePermsRemoved: (...a) => permsRemoved.trigger(...a),
		fireCookiesChanged: (...a) => cookiesChanged.trigger(...a),
	};
}

module.exports = {makeBrowserMock};
