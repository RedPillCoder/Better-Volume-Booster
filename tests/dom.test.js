"use strict";
/* jsdom-based unit tests for pages/popup.js and pages/options.js wiring. */
const fs = require("fs");
const assert = require("assert");
const {JSDOM} = require("jsdom");
const {makeBrowserMock} = require("./browser-mock.js");

const EXT = require("path").resolve(__dirname, "..");
const UTILS = fs.readFileSync(EXT + "/scripts/utils.js", "utf8");
const POPUP = fs.readFileSync(EXT + "/scripts/popup.js", "utf8");
const OPTIONS = fs.readFileSync(EXT + "/scripts/options.js", "utf8");

let passed = 0, failed = 0;
async function test(name, fn) {
	try { await fn(); passed++; console.log("  ✓ " + name); }
	catch (e) { failed++; console.error("  ✗ " + name + "\n    " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e)); }
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

const POPUP_HTML = `
<body>
<div class="option">
	<a id="restore-global-volume-multiplier" class="restore"><img src="x"/></a>
	<a id="flip-global-sound-mode" class="note beam"><img/></a>
	<input type="number" id="global-volume-multiplier-counter" class="volume-multiplier-counter" min="0" step="1"/>
	<span>%</span>
	<input type="range" id="global-volume-multiplier-range" class="volume-multiplier-range" min="0" step="5"/>
	<label>Global volume</label>
</div>
<div class="option">
	<a id="delete-local-volume-multiplier" class="restore"><img src="x"/></a>
	<a id="flip-local-sound-mode" class="note beam"><img/></a>
	<input type="number" id="local-volume-multiplier-counter" class="volume-multiplier-counter" min="0" step="1"/>
	<span>%</span>
	<input type="range" id="local-volume-multiplier-range" class="volume-multiplier-range" min="0" step="5"/>
	<label><label id="hostname-text" class="url">Local</label> volume</label>
</div>
<div class="option">
	<a id="delete-session-volume-multiplier" class="restore"><img src="x"/></a>
	<a id="flip-session-sound-mode" class="note beam"><img/></a>
	<input type="number" id="session-volume-multiplier-counter" class="volume-multiplier-counter" min="0" step="1"/>
	<span>%</span>
	<input type="range" id="session-volume-multiplier-range" class="volume-multiplier-range" min="0" step="5"/>
	<label>Session volume</label>
</div>
<div id="media-sources-message" class="option message hidden">
	<div id="media-sources-container">
		<button id="ask-permissions-button"></button>
		<a id="enable-all-permissions-button"></a>
		<ul id="media-sources-list"></ul>
	</div>
</div>
<div id="no-volume-multipliers-selected-message" class="option message hidden"></div>
<div id="no-media-detected-message" class="option message hidden"></div>
<div id="excluded-hostname-message" class="option message hidden"></div>
</body>`;

const OPTIONS_HTML = `
<body>
<div class="option">
	<input type="number" id="volume-multiplier-limit-counter" min="0" step="1"/>
	<span>%</span>
	<input type="range" id="volume-multiplier-limit-range" step="5"/>
</div>
<input type="checkbox" class="show-volume-multiplier-checkbox" id="show-global" value="global"/>
<input type="checkbox" class="show-volume-multiplier-checkbox" id="show-local" value="local"/>
<input type="checkbox" class="show-volume-multiplier-checkbox" id="show-session" value="session"/>
<input type="checkbox" id="show-audio-channel-buttons-checkbox"/>
<input type="checkbox" id="specify-permission-subdomain-checkbox"/>
<input type="checkbox" id="apply-default-local-settings-checkbox"/>
<button id="reset-storage-button"></button>
<button id="more-information-button"></button>
<button id="clear-site-data-button"></button>
<i id="cookies-permission-status"></i>
</body>`;

function makeWindow(html) {
	const dom = new JSDOM(html, {runScripts: "outside-only", pretendToBeVisual: true});
	const mock = makeBrowserMock();
	dom.window.browser = mock.browser;
	dom.window.confirm = () => dom.window.__confirmValue !== false;
	dom.window.alert = () => {};
	return {win: dom.window, mock};
}

(async () => {
	console.log("== popup.js ==");

	async function loadPopup({url = "https://sub.example.com/page", storage = {}, mediaHostnames = []} = {}) {
		const {win, mock} = makeWindow(POPUP_HTML);
		mock.setTabs([{id: 1, url}]);
		for (const [k, v] of Object.entries(storage)) mock.localData[k] = v;
		const requested = [];
		mock.browser.runtime.sendMessage = msg => {
			if (msg.action === "getMediaSources") return Promise.resolve({hostnames: mediaHostnames});
			return Promise.resolve({});
		};
		mock.browser.permissions.request = q => { requested.push(q); (q.origins ?? []).forEach(o => mock.grantedOrigins.add(o)); return Promise.resolve(true); };
		win.eval(UTILS + "\n;" + POPUP);
		await tick(80);
		return {win, mock, requested};
	}

	await test("popup applies the stored hard limit and site volume", async () => {
		const {win} = await loadPopup({
			storage: {options: {volumeMultiplierPercentLimit: 300}, "sub.example.com": {enabled: true, volume: 220}}
		});
		assert.strictEqual(win.document.getElementById("global-volume-multiplier-range").max, "300");
		assert.strictEqual(win.document.getElementById("local-volume-multiplier-counter").value, "220");
		assert.ok(!win.document.getElementById("media-sources-message").classList.contains("hidden") === false);
	});

	await test("permission prompt lists ungranted media hosts (registrable by default)", async () => {
		const {win} = await loadPopup({mediaHostnames: ["cdn.example.com", "media.other.net", "cdn.example.com"]});
		const msg = win.document.getElementById("media-sources-message");
		assert.ok(!msg.classList.contains("hidden"), "prompt must be visible");
		const names = Array.from(win.document.getElementsByClassName("media-source-checkbox")).map(c => c.name).sort();
		assert.strictEqual(JSON.stringify(names), JSON.stringify(["example.com", "other.net"]));
	});

	await test("subdomain mode keeps reported subdomains in the prompt", async () => {
		const {win} = await loadPopup({
			mediaHostnames: ["cdn.example.com", "media.other.net"],
			storage: {options: {specifyPermissionSubdomains: true}}
		});
		const names = Array.from(win.document.getElementsByClassName("media-source-checkbox")).map(c => c.name).sort();
		assert.strictEqual(JSON.stringify(names), JSON.stringify(["cdn.example.com", "media.other.net"]));
	});

	await test("ask-permissions requests scoped origins (+exact origin for registrable domains)", async () => {
		const {win, requested} = await loadPopup({mediaHostnames: ["cdn.example.com", "media.other.net"]});
		win.document.getElementById("ask-permissions-button").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.strictEqual(requested.length, 1);
		const origins = requested[0].origins.sort();
		assert.strictEqual(JSON.stringify(origins), JSON.stringify([
			"*://*.example.com/*",
			"*://example.com/*",
			"*://*.other.net/*",
			"*://other.net/*"
		].sort()));
	});

	await test("enable-all is gated behind confirmation", async () => {
		const {win, requested} = await loadPopup({});
		win.__confirmValue = false;
		win.document.getElementById("enable-all-permissions-button").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.strictEqual(requested.length, 0, "no request when declined");
		win.__confirmValue = true;
		win.document.getElementById("enable-all-permissions-button").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.strictEqual(requested.length, 1);
		assert.strictEqual(JSON.stringify(requested[0].origins), JSON.stringify(["<all_urls>"]));
	});

	await test("deleting the local multiplier falls back to global and clears stored values", async () => {
		const {win, mock} = await loadPopup({
			storage: {"sub.example.com": {enabled: true, volume: 220, mono: true}}
		});
		win.document.getElementById("delete-local-volume-multiplier").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		const entry = mock.localData["sub.example.com"];
		assert.strictEqual(entry.enabled, false);
		assert.ok(!("volume" in entry), "volume must be deleted");
		assert.ok(!("mono" in entry), "mono must be deleted");
	});

	await test("restore-global resets to 100% stereo", async () => {
		const {win, mock} = await loadPopup({storage: {global: {volume: 400, mono: true}}});
		win.document.getElementById("restore-global-volume-multiplier").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.strictEqual(mock.localData.global.volume, 100);
		assert.strictEqual(mock.localData.global.mono, false);
	});

	await test("session multiplier is restored for the current url and can be deleted", async () => {
		const {win, mock} = await loadPopup({
			url: "https://sub.example.com/watch",
			storage: {session: {url: "https://sub.example.com/watch", volume: 140, mono: true}}
		});
		assert.strictEqual(win.document.getElementById("session-volume-multiplier-counter").value, "140");
		win.document.getElementById("delete-session-volume-multiplier").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.ok(!("url" in (mock.sessionData.session ?? {})), "session url must be cleared");
	});

	console.log("== options.js ==");

	async function loadOptions({storage = {}} = {}) {
		const {win, mock} = makeWindow(OPTIONS_HTML);
		for (const [k, v] of Object.entries(storage)) mock.localData[k] = v;
		win.eval(UTILS + "\n;" + OPTIONS);
		await tick(80);
		return {win, mock};
	}

	await test("options page reflects stored settings", async () => {
		const {win} = await loadOptions({storage: {options: {volumeMultiplierPercentLimit: 250, showAudioChannelButtons: false}}});
		assert.strictEqual(win.document.getElementById("volume-multiplier-limit-counter").value, "250");
		assert.strictEqual(win.document.getElementById("show-audio-channel-buttons-checkbox").checked, false);
	});

	await test("changing the limit persists to options", async () => {
		const {win, mock} = await loadOptions({});
		const counter = win.document.getElementById("volume-multiplier-limit-counter");
		counter.value = "700";
		counter.dispatchEvent(new win.Event("input", {bubbles: true}));
		await tick(30);
		assert.strictEqual(mock.localData.options.volumeMultiplierPercentLimit, 700);
	});

	await test("forget per-site settings keeps globals", async () => {
		const {win, mock} = await loadOptions({storage: {global: {volume: 150}, "a.com": {enabled: true}, "b.com": {excluded: true}}});
		win.__confirmValue = true;
		win.document.getElementById("clear-site-data-button").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.ok(!("a.com" in mock.localData) && !("b.com" in mock.localData));
		assert.strictEqual(mock.localData.global.volume, 150);
	});

	await test("clear all settings wipes local and session storage", async () => {
		const {win, mock} = await loadOptions({storage: {global: {volume: 150}}});
		mock.sessionData.session = {url: "x", volume: 130};
		win.__confirmValue = true;
		win.document.getElementById("reset-storage-button").dispatchEvent(new win.Event("click", {bubbles: true}));
		await tick(30);
		assert.deepStrictEqual(Object.keys(mock.localData), []);
		assert.deepStrictEqual(Object.keys(mock.sessionData), []);
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
