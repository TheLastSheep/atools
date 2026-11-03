import "../../src/styles/global.css";
import { mount, unmount } from "svelte";
import AToolsMark from "../../src/components/AToolsMark.svelte";
import HomeCapabilityRail from "../../src/components/HomeCapabilityRail.svelte";
import SearchBar from "../../src/components/SearchBar.svelte";
import SettingsHeader from "../../src/components/SettingsHeader.svelte";

const app = document.querySelector<HTMLDivElement>("#app")!;
let searchValue = "";
let badgeClicks = 0;
let settingsClosed = 0;
let panelChanges = 0;
let commanded = 0;

app.innerHTML = `
  <main class="brand-fixture">
    <section class="brand-card home-card" aria-label="首页品牌">
      <h1>Home</h1>
      <div id="search"></div>
      <div id="rail"></div>
    </section>
    <section class="brand-card settings-card" aria-label="设置页品牌">
      <div id="settings-header"></div>
      <div class="about-identity"><div id="about-mark"></div><div><strong>关于概览</strong><small>ATools 3.0</small></div></div>
    </section>
    <output id="fixture-state" aria-live="polite"></output>
  </main>
`;

const mounted = [
  mount(SearchBar, {
    target: app.querySelector("#search")!,
    props: {
      query: searchValue,
      onchange: (value: string) => { searchValue = value; updateState(); },
      showBadge: true,
      onbadgeclick: () => { badgeClicks += 1; updateState(); },
      prominent: true,
    },
  }),
  mount(HomeCapabilityRail, {
    target: app.querySelector("#rail")!,
    props: {
      oncommand: () => { commanded += 1; updateState(); },
      onpanelchange: () => { panelChanges += 1; updateState(); },
    },
  }),
  mount(SettingsHeader, {
    target: app.querySelector("#settings-header")!,
    props: { onclose: () => { settingsClosed += 1; updateState(); } },
  }),
  mount(AToolsMark, { target: app.querySelector("#about-mark")!, props: { size: "small" } }),
];

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; min-width: 320px; background: var(--bg-secondary, #f4f5f8); color: var(--text-primary, #20232a); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .brand-fixture { box-sizing: border-box; width: min(100%, 800px); min-height: 560px; margin: 20px auto; padding: 20px; display: grid; grid-template-columns: 1fr 1fr; align-content: start; gap: 16px; }
  .brand-card { min-width: 0; overflow: hidden; border: 1px solid var(--border, #dfe2e8); border-radius: 14px; background: var(--bg-primary, #fff); }
  .brand-card h1 { margin: 14px 18px; font-size: 12px; font-weight: 650; letter-spacing: .04em; color: var(--text-secondary, #6b7280); text-transform: uppercase; }
  #search { margin: 16px; }
  #rail { margin: 16px; }
  .settings-card { padding-bottom: 20px; }
  .about-identity { display: flex; align-items: center; gap: 12px; margin: 18px 22px; }
  .about-identity strong, .about-identity small { display: block; }
  .about-identity small { margin-top: 2px; color: var(--text-secondary, #6b7280); }
  #fixture-state { grid-column: 1 / -1; min-width: 0; max-width: 100%; min-height: 20px; overflow-wrap: anywhere; color: var(--text-secondary, #6b7280); font-size: 12px; }
  :root[data-atools-theme="dark"] body { background: #15161b; color: #f3f4f7; }
  :root[data-atools-theme="dark"] .brand-card { border-color: #343641; background: #202127; }
  @media (max-width: 560px) { .brand-fixture { grid-template-columns: minmax(0, 1fr); min-height: 0; margin: 0 auto; padding: 12px; gap: 12px; } #fixture-state { grid-column: auto; } }
`;
document.head.append(style);

function updateState() {
  app.querySelector("#fixture-state")!.textContent = JSON.stringify({ searchValue, badgeClicks, settingsClosed, panelChanges, commanded });
}

Object.assign(window, {
  atoolsBrandFixture: {
    setTheme(theme: "light" | "dark") { document.documentElement.dataset.atoolsTheme = theme; },
    async dispose() { for (const component of mounted.reverse()) await unmount(component); style.remove(); },
  },
});
updateState();
