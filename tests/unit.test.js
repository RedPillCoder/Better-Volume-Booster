"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const {makeBrowserMock} = require("./browser-mock.js");

const EXT = path.resolve(__dirname, "..");
const UTILS = fs.readFileSync(path.join(EXT, "scripts/utils.js"), "utf8");
const BACKGROUND = fs.readFileSync(path.join(EXT, "scripts/background.js"), "utf8");

let passed = 0, failed = 0;
async function test(name, fn) {
	try { await fn(); passed++; console.log("  ✓ " + name); }
	catch (e) { failed++; console.error("  ✗ " + name + "\n    " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e)); }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function loadContext(withBackground = true) {
	const mock = makeBrowserMock();
	const context = {
		browser: mock.browser,
		console,
		setTimeout, clearTimeout,
		URL, Promise, Object, Array, Set, Map, JSON,
	};
	vm.createContext(context);
	vm.runInContext(UTILS, context, {filename: "utils.js"});
	if (withBackground) vm.runInContext(BACKGROUND, context, {filename: "background.js"});
	return {mock, context,
		getStorage: (h) => vm.runInContext(`getStorage(${h === undefined ? "" : JSON.stringify(h)})`, context),
		setStorage: (o) => vm.runInContext(`setStorage(${JSON.stringify(o)})`, context),
	};
}

(async () => {
	console.log("== utils.js ==");

	await test("defaults are produced on empty storage", async () => {
		const {getStorage} = loadContext(false);
		const s = await getStorage();
		assert.strictEqual(s.options.volumeMultiplierPercentLimit, 500);
		assert.strictEqual(s.global.volume, 100);
		assert.strictEqual(s.global.mono, false);
		assert.strictEqual(s.session.volume, 100);
	});

	await test("enabled per-site settings are kept, disabled ones inherit global", async () => {
		const {mock, getStorage} = loadContext(false);
		mock.localData["a.com"] = {enabled: true, volume: 300, mono: true};
		mock.localData["b.com"] = {enabled: false};
		mock.localData["global"] = {volume: 150, mono: false};
		const s = await getStorage("a.com");
		assert.strictEqual(s["a.com"].volume, 300);
		assert.strictEqual(s["a.com"].mono, true);
		const s2 = await getStorage("b.com");
		assert.strictEqual(s2["b.com"].volume, 150, "disabled site must fall back to global volume");
	});

	await test("v1.13 backwards compatibility (volumeMultiplierPercent)", async () => {
		const {mock, getStorage} = loadContext(false);
		mock.localData["old.com"] = {enabled: true, volumeMultiplierPercent: 250};
		const s = await getStorage("old.com");
		assert.strictEqual(s["old.com"].volume, 250);
	});

	await test("setStorage deep-merges and deletes undefined keys", async () => {
		const {mock, context, getStorage} = loadContext(false);
		await vm.runInContext("setStorage({global: {volume: 200}})", context);
		await vm.runInContext("setStorage({global: {volume: undefined}})", context);
		const s = await getStorage();
		assert.strictEqual(s.global.volume, 100, "deleted key must fall back to default");
	});

	await test("session data goes to RAM-only storage.session, not local", async () => {
		const {mock, setStorage, getStorage} = loadContext(false);
		await setStorage({session: {url: "https://x.com/v", volume: 130}});
		assert.ok(!("session" in mock.localData), "session must not be persisted in storage.local");
		assert.strictEqual(mock.sessionData.session.volume, 130);
		const s = await getStorage();
		assert.strictEqual(s.session.volume, 130);
	});

	await test("legacy on-disk session is migrated to storage.session", async () => {
		const {mock, getStorage} = loadContext(false);
		mock.localData["session"] = {url: "https://old.com/", volume: 111};
		const s = await getStorage();
		assert.strictEqual(s.session.volume, 111);
		await tick();
		assert.ok(!("session" in mock.localData), "legacy session key must be removed from disk");
	});

	console.log("== background.js: scoped CORS rules ==");

	await test("ensureCors creates a rule scoped to (initiator -> media domain)", async () => {
		const {mock} = loadContext();
		const res = await mock.dispatchRuntime(
			{action: "ensureCors", initiator: "page.com", domain: "cdn.net"},
			{tab: {id: 1, url: "https://page.com/"}});
		assert.strictEqual(res.ok, true);
		assert.strictEqual(mock.dynamicRules.length, 1);
		const rule = mock.dynamicRules[0];
		assert.strictEqual(rule.action.responseHeaders[0].header, "Access-Control-Allow-Origin");
		assert.strictEqual(JSON.stringify(rule.condition.initiatorDomains), JSON.stringify(["page.com"]));
		assert.strictEqual(JSON.stringify(rule.condition.requestDomains), JSON.stringify(["cdn.net"]));
		assert.strictEqual(JSON.stringify(rule.condition.resourceTypes), JSON.stringify(["media"]));
	});

	await test("same pair from another tab reuses the rule; removed only when last tab goes", async () => {
		const {mock} = loadContext();
		await mock.dispatchRuntime({action: "ensureCors", initiator: "p.com", domain: "c.net"}, {tab: {id: 1}});
		await mock.dispatchRuntime({action: "ensureCors", initiator: "p.com", domain: "c.net"}, {tab: {id: 2}});
		assert.strictEqual(mock.dynamicRules.length, 1, "pair must map to a single rule");

		await mock.fireTabsRemoved(1);
		assert.strictEqual(mock.dynamicRules.length, 1, "rule must survive while another tab uses it");
		await mock.fireTabsRemoved(2);
		assert.strictEqual(mock.dynamicRules.length, 0, "rule must be removed with the last tab");
	});

	await test("navigating to another hostname drops that tab's CORS rules", async () => {
		const {mock} = loadContext();
		mock.setTabs([{id: 1, url: "https://p.com/"}]);
		await mock.dispatchRuntime({action: "ensureCors", initiator: "p.com", domain: "c.net"}, {tab: {id: 1}});
		assert.strictEqual(mock.dynamicRules.length, 1);
		await mock.fireTabsUpdated(1, {status: "loading"}, {id: 1, url: "https://other.org/"});
		assert.strictEqual(mock.dynamicRules.length, 0);
	});

	await test("excluded initiator is refused", async () => {
		const {mock} = loadContext();
		mock.localData["ex.com"] = {enabled: true, excluded: true};
		const res = await mock.dispatchRuntime({action: "ensureCors", initiator: "ex.com", domain: "c.net"}, {tab: {id: 1}});
		assert.strictEqual(res.ok, false);
		assert.strictEqual(mock.dynamicRules.length, 0);
	});

	console.log("== background.js: cookie rules ==");

	await test("container tabs neither create nor remove cookie rules", async () => {
		const {mock} = loadContext();
		mock.grantedPermissions.add("cookies");
		mock.setCookies([{name: "sid", value: "42", domain: ".tiktok.com"}]);
		await tick(); // startup rebuild (default store) has run
		const before = JSON.stringify(mock.dynamicRules.map(r => r.id));
		assert.ok(mock.dynamicRules.some(r => r.action.requestHeaders), "default-store rule exists after boot");

		// a container tab loading the flagged site must leave rules untouched
		await mock.dispatchRuntime({action: "updateRequests"},
			{tab: {id: 5, url: "https://www.tiktok.com/", cookieStoreId: "firefox-container-1"}});
		await tick();
		assert.strictEqual(JSON.stringify(mock.dynamicRules.map(r => r.id)), before,
			"container tab must not create or remove rules");
	});

	await test("enabling 'send cookies' from a container tab stores the flag but creates no rule", async () => {
		const {mock} = loadContext();
		mock.setCookies([{name: "c", value: "1", domain: ".site.io"}]);
		await mock.fireContextClicked({menuItemId: "send-cookies"},
			{id: 4, url: "https://www.site.io/", cookieStoreId: "firefox-container-2"});
		await tick();
		const s = await vm.runInContext('getStorage("www.site.io")', createContextFrom(mock));
		assert.strictEqual(s["www.site.io"].sendCookiesInMediaRequests, true, "flag is remembered");
		assert.ok(!mock.dynamicRules.some(r => r.action.requestHeaders), "no cookie rule for containers");
	});

	await test("cookie rule is same-site scoped and unquoted", async () => {
		const {mock} = loadContext();
		mock.grantedPermissions.add("cookies");
		mock.setCookies([{name: "sid", value: "42", domain: ".tiktok.com"}, {name: "a", value: "b", domain: ".tiktok.com"}]);
		await mock.dispatchRuntime({action: "updateRequests"}, {tab: {id: 5, url: "https://www.tiktok.com/foryou"}});
		await tick();
		const cookieRule = mock.dynamicRules.find(r => r.action.requestHeaders);
		assert.ok(cookieRule, "cookie rule must exist (tiktok default opt-in)");
		assert.strictEqual(JSON.stringify(cookieRule.condition.requestDomains), JSON.stringify(["tiktok.com"]));
		assert.strictEqual(JSON.stringify(cookieRule.condition.initiatorDomains), JSON.stringify(["tiktok.com"]));
		assert.strictEqual(cookieRule.action.requestHeaders[0].value, "sid=42; a=b");
	});

	await test("no cookie rule without the optional cookies permission", async () => {
		const {mock} = loadContext();
		mock.setCookies([{name: "sid", value: "42", domain: ".tiktok.com"}]);
		await mock.dispatchRuntime({action: "updateRequests"}, {tab: {id: 5, url: "https://www.tiktok.com/"}});
		await tick();
		assert.ok(!mock.dynamicRules.some(r => r.action.requestHeaders), "must not create cookie rule without permission");
	});

	await test("revoking the cookies permission removes all cookie rules", async () => {
		const {mock} = loadContext();
		mock.grantedPermissions.add("cookies");
		mock.setCookies([{name: "sid", value: "42", domain: ".tiktok.com"}]);
		await mock.dispatchRuntime({action: "updateRequests"}, {tab: {id: 5, url: "https://www.tiktok.com/"}});
		await tick();
		assert.ok(mock.dynamicRules.some(r => r.action.requestHeaders));
		mock.grantedPermissions.delete("cookies");
		await mock.firePermsRemoved({permissions: ["cookies"]});
		await tick();
		assert.ok(!mock.dynamicRules.some(r => r.action.requestHeaders), "rules must be wiped on revocation");
	});

	await test("cookie changes refresh the rule (debounced)", async () => {
		const {mock} = loadContext();
		mock.grantedPermissions.add("cookies");
		mock.setCookies([{name: "sid", value: "old", domain: ".tiktok.com"}]);
		await mock.dispatchRuntime({action: "updateRequests"}, {tab: {id: 5, url: "https://www.tiktok.com/"}});
		await tick();
		mock.setCookies([{name: "sid", value: "new", domain: ".tiktok.com"}]);
		await mock.fireCookiesChanged({cookie: {domain: ".tiktok.com"}});
		await tick(700);
		const rule = mock.dynamicRules.find(r => r.action.requestHeaders);
		assert.strictEqual(rule.action.requestHeaders[0].value, "sid=new");
	});

	console.log("== background.js: effective settings & media sources ==");

	await test("getEffective prefers session when url matches, else site/global", async () => {
		const {mock} = loadContext();
		mock.localData["global"] = {volume: 150};
		mock.localData["s.com"] = {enabled: true, volume: 200};
		mock.sessionData.session = {url: "https://s.com/watch", volume: 300, mono: true};

		const a = await mock.dispatchRuntime({action: "getEffective", url: "https://s.com/watch"}, {tab: {id: 1}});
		assert.strictEqual(a.volume, 300);
		assert.strictEqual(a.mono, true);

		const b = await mock.dispatchRuntime({action: "getEffective", url: "https://s.com/other"}, {tab: {id: 1}});
		assert.strictEqual(b.volume, 200);

		const c = await mock.dispatchRuntime({action: "getEffective", url: "https://plain.org/"}, {tab: {id: 1}});
		assert.strictEqual(c.volume, 150);
	});

	await test("getEffective reports excluded sites", async () => {
		const {mock} = loadContext();
		mock.localData["ex.com"] = {enabled: true, excluded: true};
		const r = await mock.dispatchRuntime({action: "getEffective", url: "https://ex.com/"}, {tab: {id: 1}});
		assert.strictEqual(r.excluded, true);
	});

	await test("media source reports are stored per tab and served to the popup", async () => {
		const {mock} = loadContext();
		await mock.dispatchRuntime({action: "reportMediaSources", hostnames: ["cdn.a.net", "cdn.b.net"]}, {tab: {id: 7}});
		await mock.dispatchRuntime({action: "reportMediaSources", hostnames: ["cdn.a.net"]}, {tab: {id: 7}});
		const res = await mock.dispatchRuntime({action: "getMediaSources", tabId: 7}, {});
		assert.deepStrictEqual(res.hostnames.sort(), ["cdn.a.net", "cdn.b.net"]);
	});

	await test("storage changes broadcast updateVolume to all tabs", async () => {
		const {mock, setStorage} = loadContext();
		mock.setTabs([{id: 1, url: "https://a.com/"}, {id: 2, url: "https://b.com/"}]);
		await setStorage({global: {volume: 120}});
		await tick(250);
		const updates = mock.sentTabMessages.filter(m => m.message.action === "updateVolume");
		assert.ok(updates.length >= 2, "both tabs must receive updateVolume");
	});

	await test("storage-write bursts coalesce into a single broadcast", async () => {
		const {mock, setStorage} = loadContext();
		mock.setTabs([{id: 1, url: "https://a.com/"}, {id: 2, url: "https://b.com/"}]);
		await tick(250);
		mock.sentTabMessages.length = 0;
		await setStorage({global: {volume: 110}});
		await setStorage({global: {volume: 120}});
		await setStorage({global: {volume: 130}});
		await tick(300);
		const updates = mock.sentTabMessages.filter(x => x.message.action === "updateVolume");
		assert.strictEqual(updates.length, 2, "one broadcast per tab for the whole burst");
	});

	console.log("== background.js: context menu toggles ==");

	await test("context menu toggles exclusion and persists it", async () => {
		const {mock} = loadContext();
		await mock.fireContextClicked({menuItemId: "exclude-hostname"}, {id: 3, url: "https://menu.com/"});
		const s = await vm.runInContext('getStorage("menu.com")', createContextFrom(mock));
		assert.strictEqual(s["menu.com"].excluded, true);
	});

	function createContextFrom(mock) {
		const context = {browser: mock.browser, console, setTimeout, clearTimeout, URL, Promise, Object, Array, Set, Map, JSON};
		vm.createContext(context);
		vm.runInContext(UTILS, context);
		return context;
	}

	await test("enabling 'send cookies' via menu requests the optional permission and creates the rule", async () => {
		const {mock} = loadContext();
		mock.setCookies([{name: "c", value: "1", domain: ".site.io"}]);
		await mock.fireContextClicked({menuItemId: "send-cookies"}, {id: 4, url: "https://www.site.io/"});
		await tick();
		assert.ok(mock.grantedPermissions.has("cookies"), "permission must have been requested+granted");
		assert.ok(mock.dynamicRules.some(r => r.action.requestHeaders), "cookie rule must be installed");
	});

	console.log("== v1.17 hardening ==");

	await test("updateRequests response is minimal (no settings leak to content)", async () => {
		const {mock} = loadContext();
		const res = await mock.dispatchRuntime({action: "updateRequests"}, {tab: {id: 1, url: "https://p.com/"}});
		assert.deepStrictEqual(Object.keys(res).sort(), ["excluded", "url"]);
		assert.strictEqual(res.excluded, false);
	});

	await test("ensureCors rejects invalid hostnames", async () => {
		const {mock} = loadContext();
		for (const bad of ["bad host", "a b.c", "", "x".repeat(300), "evil.com/", "-a.com"]) {
			const res = await mock.dispatchRuntime({action: "ensureCors", initiator: "p.com", domain: bad}, {tab: {id: 1}});
			assert.strictEqual(res.ok, false, `domain ${JSON.stringify(bad)} must be rejected`);
		}
		assert.strictEqual(mock.dynamicRules.length, 0);
	});

	await test("reportMediaSources drops invalid hostnames", async () => {
		const {mock} = loadContext();
		await mock.dispatchRuntime({action: "reportMediaSources", hostnames: ["good.net", "bad host", ""]}, {tab: {id: 3}});
		const res = await mock.dispatchRuntime({action: "getMediaSources", tabId: 3}, {});
		assert.strictEqual(JSON.stringify(res.hostnames), JSON.stringify(["good.net"]));
	});

	await test("hard limit clamps effective volumes retroactively", async () => {
		const {mock, getStorage} = loadContext(false);
		mock.localData["options"] = {volumeMultiplierPercentLimit: 200};
		mock.localData["global"] = {volume: 500};
		mock.localData["c.com"] = {enabled: true, volume: 800};
		mock.sessionData.session = {url: "https://c.com/v", volume: 900};
		const s = await getStorage("c.com");
		assert.strictEqual(s.global.volume, 200);
		assert.strictEqual(s["c.com"].volume, 200);
		assert.strictEqual(s.session.volume, 200);
	});

	await test("getEffective works for file:// (empty hostname) pages", async () => {
		const {mock} = loadContext();
		const r = await mock.dispatchRuntime({action: "getEffective", url: "file:///tmp/song.mp3"}, {tab: {id: 1}});
		assert.strictEqual(r.excluded, false);
		assert.strictEqual(r.volume, 100);
	});

	await test("cookie header values are sanitized (no CRLF/delimiter injection)", async () => {
		const {mock} = loadContext();
		mock.grantedPermissions.add("cookies");
		mock.setCookies([
			{name: "good", value: "1", domain: ".tiktok.com"},
			{name: "bad", value: "x\r\nX-Evil: yes", domain: ".tiktok.com"},
			{name: "semi", value: "a; b", domain: ".tiktok.com"}
		]);
		await mock.dispatchRuntime({action: "updateRequests"}, {tab: {id: 5, url: "https://www.tiktok.com/"}});
		await tick();
		const rule = mock.dynamicRules.find(r => r.action.requestHeaders);
		assert.ok(rule, "rule with only safe cookies must exist");
		assert.strictEqual(rule.action.requestHeaders[0].value, "good=1");
	});

	await test("registrableDomain is public-suffix aware", async () => {
		const {context} = loadContext(false);
		const run = e => vm.runInContext(`registrableDomain(${JSON.stringify(e)})`, context);
		assert.strictEqual(run("www.bbc.co.uk"), "bbc.co.uk");
		assert.strictEqual(run("a.shop.com.au"), "shop.com.au");
		assert.strictEqual(run("x.y.example.com"), "example.com");
		assert.strictEqual(run("localhost"), "localhost");
		assert.strictEqual(run("127.0.0.1"), "127.0.0.1");
	});

	await test("permission reduction keeps ccTLD registrable domains intact", async () => {
		const {context} = loadContext(false);
		assert.strictEqual(
			JSON.stringify(vm.runInContext(`getEssentialHostnames(["a.bbc.co.uk","images.bbc.co.uk"], false).sort()`, context)),
			JSON.stringify(["bbc.co.uk"]));
	});

	await test("startup prunes orphaned CORS rules and stale cookie rules", async () => {
		const {mock} = loadContext();
		mock.grantedPermissions.add("cookies");
		mock.setCookies([{name: "sid", value: "42", domain: ".tiktok.com"}]);
		// leftover rules from a "previous boot"
		mock.dynamicRules.push(
			{id: 1500, priority: 1, action: {type: "modifyHeaders", responseHeaders: [{header: "Access-Control-Allow-Origin", operation: "set", value: "*"}]},
			 condition: {resourceTypes: ["media"], initiatorDomains: ["gone.com"], requestDomains: ["c.net"]}},
			{id: 5, priority: 1, action: {type: "modifyHeaders", requestHeaders: [{header: "Cookie", operation: "set", value: "old=1"}]},
			 condition: {resourceTypes: ["media"], initiatorDomains: ["tiktok.com"], requestDomains: ["tiktok.com"]}}
		);
		await tick(50);
		const cors = mock.dynamicRules.filter(r => r.action.responseHeaders);
		const cookie = mock.dynamicRules.filter(r => r.action.requestHeaders);
		assert.strictEqual(cors.length, 0, "orphaned CORS rule must be pruned");
		assert.strictEqual(cookie.length, 1, "cookie rule must be rebuilt exactly once");
		assert.notStrictEqual(cookie[0].id, 5, "stale cookie rule id must be purged");
		assert.strictEqual(JSON.stringify(cookie[0].condition.requestDomains), JSON.stringify(["tiktok.com"]));
	});

	await test("surviving CORS rules are re-associated to live tabs", async () => {
		const {mock} = loadContext();
		mock.setTabs([{id: 9, url: "https://p.com/x"}]);
		mock.dynamicRules.push(
			{id: 1200, priority: 1, action: {type: "modifyHeaders", responseHeaders: [{header: "Access-Control-Allow-Origin", operation: "set", value: "*"}]},
			 condition: {resourceTypes: ["media"], initiatorDomains: ["p.com"], requestDomains: ["c.net"]}}
		);
		await tick(50);
		// same pair from the same tab must reuse the surviving rule
		await mock.dispatchRuntime({action: "ensureCors", initiator: "p.com", domain: "c.net"}, {tab: {id: 9}});
		assert.strictEqual(mock.dynamicRules.length, 1);
		assert.strictEqual(mock.dynamicRules[0].id, 1200);
		// and tab cleanup still removes it
		await mock.fireTabsRemoved(9);
		assert.strictEqual(mock.dynamicRules.length, 0);
	});

	await test("getEssentialHostnames uses true subdomain logic", async () => {
		const {context} = loadContext(false);
		const run = expr => vm.runInContext(expr, context);
		assert.strictEqual(
			JSON.stringify(run(`getEssentialHostnames(["cdn.a.net","a.net","evilsite.com","site.com"]).sort()`)),
			JSON.stringify(["a.net", "evilsite.com", "site.com"]),
			"subdomains collapse into parent; lookalikes stay separate");
		assert.strictEqual(
			JSON.stringify(run(`getEssentialHostnames(["cdn.a.net","www.b.net"], false).sort()`)),
			JSON.stringify(["a.net", "b.net"]),
			"registrable-domain mode still works");
		assert.strictEqual(
			JSON.stringify(run(`getEssentialHostnames(["notsite.com"]).sort()`)),
			JSON.stringify(["notsite.com"]));
	});

	await test("denied permission leaves the feature off and opens the options page", async () => {
		const {mock} = loadContext();
		mock.setCookieRequestPermission(false);
		await mock.fireContextClicked({menuItemId: "send-cookies"}, {id: 4, url: "https://www.site.io/"});
		await tick();
		const s = await vm.runInContext('getStorage("www.site.io")', createContextFrom(mock));
		assert.strictEqual(s["www.site.io"].sendCookiesInMediaRequests, false);
		assert.ok(mock.openedTabs.some(u => u.includes("options.html")), "options page must open as fallback");
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
