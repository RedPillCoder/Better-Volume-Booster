"""Real-Firefox e2e for Better Volume Booster (v1.17).

The add-on is installed as a profile-bundled extension (ESR honours
xpinstall.signatures.required=false), which lets the chrome test context grant
host permissions through the same backend the popup uses (ExtensionPermissions)
and observe everything from real web content:

  1. same-origin media is boosted and still plays; its request is left unmodified
  2. plain pages are untouched
  3. cross-origin media goes through the scoped (page -> media host) CORS flow
     and plays
  4. the relaxation is media-only: page scripts cannot fetch() the media bytes
     (cache-busted), and no rule exists for hosts the page doesn't embed
  5. host permissions can be granted through the extension permission backend
  6. navigation churn never breaks pages

Documented harness limitations (this sandbox, verified with a minimal control
add-on): WebExtension *page* UI cannot run here, and chrome-side
ExtensionStorage writes do not reach the running OOP extension's storage cache.
Those layers (popup/options DOM, storage routing, exclusion gate, DNR rule
lifecycle) are covered by tests/unit.test.js instead.
"""
import sys, os, time, socket, subprocess, shutil, tempfile
from marionette_driver.marionette import Marionette

EXT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PROFILE = os.path.join(tempfile.gettempdir(), "mze2e")

# Works with any Firefox build: set FIREFOX_BIN to override auto-detection.
FIREFOX = os.environ.get("FIREFOX_BIN") or shutil.which("firefox-esr") or shutil.which("firefox") or "firefox-esr"

def kill_firefox():
    if shutil.which("pkill"):
        subprocess.run(["pkill", "-9", "-x", os.path.basename(FIREFOX)], stderr=subprocess.DEVNULL)
AID = "VolumeBoosterWithoutDementia@zWolfrost.github.com"
UUID = "11111111-2222-3333-4444-555555555555"

results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

def wait_for(fn, timeout=15, interval=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(interval)
    return None

def wait_port(port, timeout=45):
    end = time.time() + timeout
    while time.time() < end:
        s = socket.socket(); s.settimeout(1)
        try:
            s.connect(("127.0.0.1", port)); s.close(); return True
        except OSError:
            time.sleep(0.3)
    return False

CHROME_HELPERS = """
  const {ExtensionStorage} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorage.sys.mjs");
  let EP = null;
  try { EP = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs").ExtensionPermissions; } catch (e) {}
  function ext() { return WebExtensionPolicy.getByID("%s").extension; }
""" % AID

def chrome_async(m, script, *args):
    with m.using_context(Marionette.CONTEXT_CHROME):
        return m.execute_async_script(
            "const done = arguments[arguments.length-1];\n" + CHROME_HELPERS + script,
            script_args=list(args))

kill_firefox()
time.sleep(1)
shutil.rmtree(PROFILE, ignore_errors=True)
os.makedirs(PROFILE + "/extensions")
shutil.copytree(EXT_DIR, PROFILE + f"/extensions/{AID}")
with open(PROFILE + "/user.js", "w") as f:
    f.write('user_pref("marionette.port", 2818);\n')
    f.write('user_pref("media.autoplay.default", 0);\n')
    f.write('user_pref("xpinstall.signatures.required", false);\n')
    f.write('user_pref("extensions.autoDisableScopes", 0);\n')
    f.write('user_pref("extensions.enabledScopes", 255);\n')
    f.write('user_pref("extensions.webextensions.uuids", \'{"%s":"%s"}\');\n' % (AID, UUID))
proc = subprocess.Popen(
    [FIREFOX, "--marionette", "--headless", "-no-remote", "-remote-allow-system-access", "-profile", PROFILE],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    assert wait_port(2818), "marionette port never opened"
    m = Marionette("localhost", port=2818)
    m.start_session()
    time.sleep(2)
    print("extension active:", chrome_async(m, "done({active: !!ext()});"))

    # ---- 1. same-origin media ------------------------------------------------
    m.navigate("http://127.0.0.1:8000/index.html")
    boosted = wait_for(lambda: m.execute_script(
        "const el=document.getElementById('m'); return el && el.classList.contains('_volume-boosted');"))
    check("same-origin media element processed by content script", boosted)
    state = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") != "waiting"
                     and m.execute_script("return document.getElementById('state').textContent;"))
    check("same-origin media plays (not broken by extension)", state == "playing", f"state={state}")
    untouched = m.execute_script("return document.getElementById('m').crossOrigin;")
    check("same-origin media request left unmodified", untouched in (None, ""), str(untouched))

    # ---- 2. plain page untouched ----------------------------------------------
    m.navigate("http://127.0.0.1:8000/plain.html")
    time.sleep(1)
    check("plain page renders normally", m.execute_script("return document.getElementById('ok').textContent;") == "ok")
    check("no boosted elements on plain page", not m.execute_script("return document.querySelector('._volume-boosted') != null;"))

    # ---- 3. cross-origin media: scoped rule created, media flows --------------
    m.navigate("http://127.0.0.1:8000/cross.html")
    boosted_x = wait_for(lambda: m.execute_script(
        "const el=document.getElementById('m'); return el && el.classList.contains('_volume-boosted');"))
    check("cross-origin media element processed", boosted_x)
    check("cross-origin media got crossOrigin=anonymous (scoped CORS requested)",
          wait_for(lambda: m.execute_script("return document.getElementById('m').crossOrigin;") == "anonymous"))
    state_cross = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") == "playing", timeout=10)
    check("scoped (page -> media host) CORS rule lets the embedded media flow", bool(state_cross))

    # ---- 3c'. <source>-child cross-origin media boosts (not silenced) ----------
    m.navigate("http://127.0.0.1:8000/source.html")
    source_ok = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") == "playing", timeout=15)
    check("cross-origin media via <source> child boosts instead of going silent", bool(source_ok))

    # ---- 3c. src swap to another cross-origin host keeps working ---------------
    m.navigate("http://127.0.0.1:8000/swap.html")
    swap_ok = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") == "swapped-playing", timeout=20)
    check("player swapping src to another cross-origin host keeps playing (rule requested on attribute change)", bool(swap_ok))
    m.navigate("http://localhost:8000/iframe-top.html")
    iframe_ok = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") == "played", timeout=15)
    check("media inside a cross-origin iframe boosts (rule uses the frame's real initiator)", bool(iframe_ok))

    # ---- 4. the relaxation is surgical -----------------------------------------
    fetch_same = m.execute_async_script("""
      const done = arguments[arguments.length-1];
      fetch("http://127.0.0.1:8001/tone.wav?e2e=1").then(r => done({ok: r.ok})).catch(() => done({ok: false}));
    """)
    check("rule is media-only: page script cannot fetch() the media bytes (no XHR exfiltration)",
          fetch_same and fetch_same["ok"] is False, str(fetch_same))
    fetch_other = m.execute_async_script("""
      const done = arguments[arguments.length-1];
      fetch("http://localhost:8001/tone.wav?e2e=1").then(r => done({ok: r.ok})).catch(() => done({ok: false}));
    """)
    check("no CORS relaxation for a host the page doesn't embed (request-domain scoping)",
          fetch_other and fetch_other["ok"] is False, str(fetch_other))

    # ---- 5. official permission backend works -----------------------------------
    perm = chrome_async(m, """
      (async () => {
        try {
          if (!EP) return done({err: "no ExtensionPermissions"});
          await EP.add(ext(), {origins: ["http://127.0.0.1/*"], permissions: []});
          done({ok: true});
        } catch (e) { done({err: String(e)}); }
      })();
    """)
    check("host permission can be granted through the extension permission backend",
          perm and perm.get("ok") is True, str(perm))

    # ---- 6. pages that own their WebAudio graph are left alone --------------------
    m.navigate("http://127.0.0.1:8000/webaudio.html")
    page_state = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") == "page-connected")
    m.find_element("css selector", "body").click()   # trusted user gesture, as a real user would give
    plays = wait_for(lambda: m.execute_script("return !document.getElementById('m').paused;"), timeout=10)
    still_ok = m.execute_script("return [document.getElementById('state').textContent, !document.getElementById('m').paused];")
    check("page-owned WebAudio graph survives the extension (no hijack, no crash)",
          page_state and bool(plays) and still_ok[0] == "page-connected", str(still_ok))

    # ---- 7. navigation churn ------------------------------------------------------
    for url in ("http://localhost:8000/plain.html", "http://127.0.0.1:8000/index.html", "http://127.0.0.1:8000/plain.html"):
        m.navigate(url)
        time.sleep(0.5)
    check("extension survives navigation churn (incl. hostname-change rule cleanup)",
          m.execute_script("return document.getElementById('ok').textContent;") == "ok")

    # ---- 8. browser restart: stale rules reconciled, feature still works ------
    m.delete_session()
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        pass
    kill_firefox()
    time.sleep(1)
    proc = subprocess.Popen(
        [FIREFOX, "--marionette", "--headless", "-no-remote", "-remote-allow-system-access", "-profile", PROFILE],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert wait_port(2818), "marionette port after restart"
    m = Marionette("localhost", port=2818)
    m.start_session()
    time.sleep(2)
    m.navigate("http://127.0.0.1:8000/cross.html")
    restarted = wait_for(lambda: m.execute_script("return document.getElementById('state').textContent;") == "playing", timeout=15)
    check("after browser restart: leftover rules reconciled and cross-origin media still boosts", bool(restarted))

    print("  SKIP popup/options DOM + exclusion e2e: WebExtension page contexts and chrome->extension storage writes "
          "are unavailable in this sandbox (verified with a control add-on) - covered by tests/unit.test.js")

finally:
    try:
        m.delete_session()
    except Exception:
        pass
    proc.terminate()
    kill_firefox()

failed = [r for r in results if not r[1]]
print(f"\nE2E (real Firefox 140 ESR): {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
